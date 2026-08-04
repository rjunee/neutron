/**
 * @neutronai/app — push-registration observability (ISSUES #487).
 *
 * The defect being fixed was NOT "push is broken". It was "a broken push
 * registration leaves no trace", which is why an empty device-token table
 * survived until a ritual fired with nowhere to send. These tests therefore
 * assert the DIAGNOSTIC, not the plumbing: that a failure emits something a
 * human can read, that a success does too, and that neither one ever writes
 * the device token — a credential — into a report.
 *
 * `lib/push.ts` itself cannot be imported here (it pulls in
 * `expo-notifications` / `react-native`, which do not load under bun test),
 * which is exactly why the outcome→diagnostic mapping lives in its own module.
 */

import { describe, expect, it } from 'bun:test';

import type { RecordInput } from '../lib/diagnostics';
import {
  PUSH_DIAGNOSTIC_KIND,
  PUSH_REPORT_REASON,
  describePushEnableOutcome,
  isActionableFailure,
  reportPushEnableOutcome,
  type PushEnableOutcome,
  type PushObservabilityDeps,
} from '../lib/push-observability';

function spy(): PushObservabilityDeps & {
  recorded: RecordInput[];
  captured: string[];
} {
  const recorded: RecordInput[] = [];
  const captured: string[] = [];
  return {
    recorded,
    captured,
    record: (input) => recorded.push(input),
    capture: async (reason) => {
      captured.push(reason);
      return null;
    },
  };
}

/** Everything a recorded event would ever put on the wire, as one string. */
function rendered(events: readonly RecordInput[]): string {
  return JSON.stringify(events);
}

const REAL_TOKEN = 'ExponentPushToken[SUPER-SECRET-DEVICE-CREDENTIAL-xyz123]';

describe('push registration observability — a failure is no longer discarded', () => {
  it('records a warning when the owner denied notification permission', async () => {
    const deps = spy();
    await reportPushEnableOutcome(
      { ok: false, skipped: true, reason: 'permission_denied' },
      deps,
    );
    expect(deps.recorded.length).toBe(1);
    const event = deps.recorded[0];
    expect(event?.kind).toBe(PUSH_DIAGNOSTIC_KIND);
    expect(event?.level).toBe('warn');
    expect(event?.message).toContain('permission_denied');
    expect(event?.context?.['reason']).toBe('permission_denied');
  });

  it('files a report so the failure actually reaches the owner gateway', async () => {
    const deps = spy();
    await reportPushEnableOutcome(
      {
        ok: false,
        skipped: true,
        reason: 'token_error',
        detail: 'gateway register failed: invalid_bearer: HTTP 401',
      },
      deps,
    );
    // Recording alone would sit in the ring buffer until a crash. The queued
    // report is what makes it travel.
    expect(deps.captured).toEqual([PUSH_REPORT_REASON]);
    expect(deps.recorded[0]?.context?.['detail']).toContain('HTTP 401');
  });

  it('escalates every actionable reason, not just one of them', async () => {
    for (const reason of ['permission_denied', 'no_project_id', 'token_error']) {
      const deps = spy();
      await reportPushEnableOutcome({ ok: false, skipped: true, reason }, deps);
      expect(deps.captured).toEqual([PUSH_REPORT_REASON]);
    }
  });

  it('records but does NOT escalate the web build, where push cannot exist', async () => {
    const deps = spy();
    await reportPushEnableOutcome(
      { ok: false, skipped: true, reason: 'unsupported_platform' },
      deps,
    );
    // Still visible...
    expect(deps.recorded.length).toBe(1);
    expect(deps.recorded[0]?.level).toBe('info');
    // ...but not filed, or opening the app in a browser would bury the real
    // failures under noise.
    expect(deps.captured).toEqual([]);
    expect(isActionableFailure({ ok: false, skipped: true, reason: 'unsupported_platform' }))
      .toBe(false);
  });

  it('records the success too, so "it worked" is evidence and not an assumption', async () => {
    const deps = spy();
    await reportPushEnableOutcome(
      { ok: true, device_token: REAL_TOKEN, platform: 'ios', registered: true },
      deps,
    );
    expect(deps.recorded.length).toBe(1);
    expect(deps.recorded[0]?.level).toBe('info');
    expect(deps.recorded[0]?.context?.['platform']).toBe('ios');
    expect(deps.recorded[0]?.context?.['registered']).toBe(true);
    expect(deps.captured).toEqual([]);
  });

  it('never lets a broken recorder break sign-in', async () => {
    const exploding: PushObservabilityDeps = {
      record: () => {
        throw new Error('AsyncStorage unavailable');
      },
      capture: async () => null,
    };
    // No assertion beyond "this resolves": the whole point is that
    // instrumentation added to the login path cannot wedge the login path.
    await reportPushEnableOutcome({ ok: false, skipped: true, reason: 'token_error' }, exploding);
  });
});

describe('push registration observability — the token is a credential', () => {
  it('does not put the device token in the success diagnostic', async () => {
    const deps = spy();
    await reportPushEnableOutcome(
      { ok: true, device_token: REAL_TOKEN, platform: 'android', registered: true },
      deps,
    );
    expect(rendered(deps.recorded)).not.toContain(REAL_TOKEN);
    expect(rendered(deps.recorded)).not.toContain('SUPER-SECRET');
    // What IS recorded is its length — enough to tell a real token from an
    // empty one when a registration will not stick.
    expect(deps.recorded[0]?.context?.['token_chars']).toBe(REAL_TOKEN.length);
  });

  it('does not leak the token through a failure detail either', () => {
    const outcome: PushEnableOutcome = {
      ok: false,
      skipped: true,
      reason: 'token_error',
      detail: 'gateway register failed: request_failed: HTTP 500',
    };
    expect(JSON.stringify(describePushEnableOutcome(outcome))).not.toContain(REAL_TOKEN);
  });
});
