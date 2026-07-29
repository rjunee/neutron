/**
 * @neutronai/app — THE redaction invariant.
 *
 * This is the test that makes remote diagnostics safe to ship. ISSUES #395 was
 * a bug where the session bearer was rendered as the account display name and
 * leaked into a screenshot. A crash reporter that captured that same token and
 * shipped it to a log file would be a strictly worse version of that bug — the
 * token would then be at rest, in plain text, in a file whose whole purpose is
 * to be read and pasted around.
 *
 * So the bar here is not "we call a redact function". The bar is: given a
 * report built from events that carry the live bearer in EVERY shape we can
 * think of — a message, a nested object value, an `authorization` key, an array
 * element, a URL query string, a stack frame, a JSON-serialised request body —
 * the SERIALISED report contains neither the token nor any recognisable prefix
 * of it.
 *
 * MUTATION-VERIFIED: neutralise `buildClientReport`'s scrub (make `redactEvent`
 * return its input) and this file goes red. Evidence is in the PR body.
 */

import { describe, expect, it } from 'bun:test';

import type { DiagnosticEvent } from '../lib/diagnostic-buffer';
import { buildClientReport } from '../lib/diagnostic-report';
import { redactString } from '../lib/diagnostic-redact';

/** A realistic HS256 bearer — the exact shape `lib/auth.ts` stores. */
const BEARER =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvd25lciIsInByb2plY3Rfc2x1ZyI6ImRlbW8ifQ.s3cr3tS1gnatureV4lueTh4tMustNeverLeak';

/** The dev-lane opaque bearer, which is equally a working credential. */
const DEV_TOKEN = 'dev:owner-9f2c1ab4';

function eventsCarryingTheToken(): DiagnosticEvent[] {
  return [
    {
      at: 1,
      level: 'error',
      kind: 'js_error',
      message: `request failed: Authorization: Bearer ${BEARER}`,
    },
    {
      at: 2,
      level: 'error',
      kind: 'js_error',
      message: 'fetch rejected',
      stack: `at authedFetch (app/lib/x.ts:10)\n  headers={"authorization":"Bearer ${BEARER}"}`,
    },
    {
      at: 3,
      level: 'error',
      kind: 'js_error',
      message: 'nested context',
      context: {
        request: { headers: { authorization: `Bearer ${BEARER}` } },
        url: `https://neutron.example.com/api/app/focus?token=${BEARER}`,
        retries: [{ attempt: 1, bearer: BEARER }],
      },
    },
    {
      at: 4,
      level: 'error',
      kind: 'unhandled_rejection',
      message: `dev session ${DEV_TOKEN} rejected`,
      context: { session_token: DEV_TOKEN, note: 'harmless text' },
    },
    {
      at: 5,
      level: 'error',
      kind: 'js_error',
      message: `body=${JSON.stringify({ install_token: BEARER, code_verifier: 'abc' })}`,
    },
  ];
}

function build(secrets: readonly string[]): string {
  return JSON.stringify(
    buildClientReport({
      report_id: 'r1',
      created_at: 0,
      origin: 'https://neutron.example.com',
      reason: 'js_error',
      app: { version: '1.0.0', build: '42', platform: 'android', os_version: '14' },
      signed_in: true,
      events: eventsCarryingTheToken(),
      secrets,
    }),
  );
}

describe('diagnostic redaction invariant', () => {
  it('no part of the live bearer survives into a built report', () => {
    const serialized = build([BEARER, DEV_TOKEN]);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(DEV_TOKEN);
    // Not just the whole token: no recognisable slice of it either. A partial
    // leak is still a leak — the signature segment alone is enough to matter.
    expect(serialized).not.toContain(BEARER.split('.')[2]);
    expect(serialized).not.toContain(BEARER.slice(0, 40));
  });

  it('redacts a token the process does NOT hold (pattern rules, no exact needle)', () => {
    // The realistic failure mode: a token from an EARLIER session, captured
    // into a stack frame. The exact-value rule cannot help here, so the pattern
    // rules have to carry it alone.
    const serialized = build([]);
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain(DEV_TOKEN);
    expect(serialized).not.toContain(BEARER.split('.')[2]);
  });

  it('still preserves the diagnostic content around the redacted values', () => {
    const serialized = build([BEARER, DEV_TOKEN]);
    expect(serialized).toContain('request failed');
    expect(serialized).toContain('at authedFetch');
    expect(serialized).toContain('harmless text');
    expect(serialized).toContain('unhandled_rejection');
    // The URL is still useful once the credential is gone.
    expect(serialized).toContain('neutron.example.com');
  });

  it('redacts by KEY even when the value looks ordinary', () => {
    const report = buildClientReport({
      report_id: 'r2',
      created_at: 0,
      origin: 'https://neutron.example.com',
      reason: 'manual',
      app: { version: '1', build: null, platform: 'ios', os_version: null },
      signed_in: true,
      events: [
        {
          at: 1,
          level: 'info',
          kind: 'lifecycle',
          message: 'ok',
          context: { api_key: 'short', Cookie: 'a=b', refreshToken: 'x', keep: 'visible' },
        },
      ],
      secrets: [],
    });
    const context = report.events[0]!.context!;
    expect(context['api_key']).toBe('[redacted]');
    expect(context['Cookie']).toBe('[redacted]');
    expect(context['refreshToken']).toBe('[redacted]');
    expect(context['keep']).toBe('visible');
  });

  it('does not shred ordinary diagnostic text', () => {
    // The scrub has to stay useful, not just safe: file paths, component names
    // and short identifiers must survive.
    const text = 'TypeError: undefined is not an object at app/components/ProjectRail.tsx:118';
    expect(redactString(text, [])).toBe(text);
  });

  it('ignores too-short "secrets" rather than corrupting the report', () => {
    // An 8-char floor: below it a needle is indistinguishable from prose.
    expect(redactString('the cat sat on the mat', ['cat'])).toBe('the cat sat on the mat');
  });
});
