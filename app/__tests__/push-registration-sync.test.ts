/**
 * @neutronai/app — push re-registration (ISSUES #487).
 *
 * The defect these cover is NOT "push is broken" — the push path was verified
 * working and correctly no-opping on an empty token table. It was that NOTHING
 * EVER RE-REGISTERED: registration ran only inside the login flow, so a device
 * signed in weeks ago never called the endpoint again. Measured live
 * 2026-08-06: 0 rows in `device_push_tokens`, 0 register requests in 14 days.
 *
 * So the assertions are about WHEN a re-registration happens, and the mount
 * assertion is about whether the thing that decides is reachable at all — a
 * module that exists and is never composed is the defect shape this repo keeps
 * rediscovering.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cameToForeground,
  syncPushRegistration,
  type ForegroundState,
} from '../lib/push-registration-sync';

describe('cameToForeground', () => {
  it('fires on the background→active edge', () => {
    expect(cameToForeground('background', 'active')).toBe(true);
  });

  it('fires on inactive→active, which is how a return from OS Settings arrives', () => {
    // iOS sequences active → inactive → background → inactive → active, so
    // requiring prev === 'background' would MISS the permission-granted path,
    // the single case a user most expects to self-heal.
    expect(cameToForeground('inactive', 'active')).toBe(true);
  });

  it('does NOT re-fire when already active', () => {
    // Some platforms emit `active` repeatedly; treating each one as an arrival
    // would register on every incidental lifecycle event.
    expect(cameToForeground('active', 'active')).toBe(false);
  });

  it('does not fire on any departure from active', () => {
    const away: ForegroundState[] = ['background', 'inactive', 'unknown'];
    for (const next of away) {
      expect(cameToForeground('active', next)).toBe(false);
    }
  });
});

describe('syncPushRegistration', () => {
  it('calls enable with the resolved server and bearer', async () => {
    const calls: Array<{ base_url: string; token: string }> = [];
    const ran = await syncPushRegistration({
      enable: async (input) => {
        calls.push(input);
      },
      base_url: 'https://example.test',
      token: 'bearer-1',
      in_flight: { current: false },
    });
    expect(ran).toBe(true);
    expect(calls).toEqual([{ base_url: 'https://example.test', token: 'bearer-1' }]);
  });

  it('refuses to open a SECOND registration while one is in flight', async () => {
    let started = 0;
    // A deferred, held in an object rather than a `let`. TypeScript's
    // control-flow analysis cannot see an assignment made inside a Promise
    // executor callback, so a `let release: (() => void) | null` is still typed
    // `null` at the call site below and `release()` fails to compile. The object
    // field carries a real callable from the start, so no definite-assignment
    // assertion is needed to paper over it.
    const gate_release = { fire: (): void => {} };
    const gate = new Promise<void>((resolve) => {
      gate_release.fire = resolve;
    });
    const in_flight = { current: false };
    const enable = async (): Promise<void> => {
      started += 1;
      await gate;
    };

    const first = syncPushRegistration({
      enable,
      base_url: 'https://example.test',
      token: 't',
      in_flight,
    });
    const second = await syncPushRegistration({
      enable,
      base_url: 'https://example.test',
      token: 't',
      in_flight,
    });

    expect(second).toBe(false);
    expect(started).toBe(1);
    gate_release.fire();
    expect(await first).toBe(true);
  });

  it('clears the guard after a THROWING enable, so one bad attempt cannot wedge it forever', async () => {
    // The regression that matters most here: if the guard leaked on the failure
    // path, registration would stop healing after its first transient error and
    // nothing would look broken.
    const in_flight = { current: false };
    let attempts = 0;
    const enable = async (): Promise<void> => {
      attempts += 1;
      throw new Error('network down');
    };

    const first = await syncPushRegistration({
      enable,
      base_url: 'https://example.test',
      token: 't',
      in_flight,
    });
    expect(first).toBe(true);
    expect(in_flight.current).toBe(false);

    const second = await syncPushRegistration({
      enable,
      base_url: 'https://example.test',
      token: 't',
      in_flight,
    });
    expect(second).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('wiring', () => {
  // `PushRegistrationSync.tsx` cannot be imported here — it pulls in
  // `react-native` / `expo-notifications`, which do not load under bun test
  // (same constraint documented in push-observability.test.ts). A source
  // assertion is the available way to prove the component is actually MOUNTED,
  // and mounting is precisely the step whose absence has shipped before: a
  // module that exists, has passing tests, and is composed by nobody.
  const layout = readFileSync(join(import.meta.dir, '..', 'app', '_layout.tsx'), 'utf8');

  it('is imported by the root layout', () => {
    expect(layout).toContain("from '../components/PushRegistrationSync'");
  });

  it('is rendered inside the authenticated session provider', () => {
    expect(layout).toContain('<PushRegistrationSync />');
    const mount = layout.indexOf('<PushRegistrationSync />');
    const providerOpen = layout.indexOf('<AuthSessionProvider');
    const providerClose = layout.indexOf('</AuthSessionProvider>');
    expect(providerOpen).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(providerOpen);
    expect(mount).toBeLessThan(providerClose);
  });
});
