/**
 * The mobile client for per-project connected-account selection (ISSUES #501).
 *
 * The web Settings tab has had this since #500; mobile had no UI or client bound to
 * it, so the owner could see the enforcement but never the control.
 *
 * THE TRAP THIS FILE EXISTS TO PIN. The underlying store is a DISABLE list: a
 * project with no rows reads EVERY connected account (`migrations/0115`, SPEC
 * Decisions Log 2026-08-04). A client that wrote an ENABLE list, or that treated
 * "no rows" as "nothing selected" and rendered every account off, would invert the
 * whole design — and it would do so silently, because the wire shape is identical
 * either way. So the tests below assert that `enabled` travels FROM the server
 * unmodified and that the write sends exactly the owner's intent.
 *
 * Same routes as the web client, deliberately: one server surface, two clients.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ProjectCredentialsClient,
  type ServiceAccountSelection,
} from '../lib/project-credentials-client';

const BASE = 'https://t.neutron.test';
const TOKEN = 'dev:owner';

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function stub(res: { status: number; body: unknown }): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

const SERVICES: ServiceAccountSelection[] = [
  {
    service: 'google_calendar',
    accounts: [
      { account_id: 'a1', label: 'Work', account_email: 'work@example.test', enabled: true },
      { account_id: 'a2', label: 'Personal', account_email: null, enabled: false },
    ],
  },
];

function make(res: { status: number; body: unknown }) {
  const s = stub(res);
  const client = new ProjectCredentialsClient({
    base_url: BASE,
    token: TOKEN,
    fetchImpl: s.fetchImpl as unknown as typeof fetch,
  });
  return { client, calls: s.calls };
}

describe('listAccounts', () => {
  it('hits the same route the web client uses', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, project_id: 'p1', services: SERVICES } });
    await client.listAccounts('p1');
    expect(calls[0]?.url).toBe(`${BASE}/api/app/projects/p1/accounts`);
    expect(calls[0]?.method).toBe('GET');
  });

  it('returns the server\'s `enabled` UNCHANGED, both true and false', async () => {
    // The disable-list trap. Any local recomputation shows up here.
    const { client } = make({ status: 200, body: { ok: true, project_id: 'p1', services: SERVICES } });
    const out = await client.listAccounts('p1');
    expect(out[0]?.accounts.map((a) => a.enabled)).toEqual([true, false]);
    expect(out[0]?.accounts[0]?.label).toBe('Work');
    expect(out[0]?.accounts[1]?.account_email).toBeNull();
  });

  it('an EMPTY services list stays empty — it is never expanded into "all off"', async () => {
    // "No rows" means every account enabled, which the SERVER expresses by sending
    // accounts with enabled:true. A client that invented rows here, or that
    // rendered an empty list as a set of disabled accounts, would invert the design.
    const { client } = make({ status: 200, body: { ok: true, project_id: 'p1', services: [] } });
    expect(await client.listAccounts('p1')).toEqual([]);
  });

  it('a response missing `services` degrades to empty rather than throwing', async () => {
    const { client } = make({ status: 200, body: { ok: true, project_id: 'p1' } });
    expect(await client.listAccounts('p1')).toEqual([]);
  });

  it('percent-encodes the project id', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, project_id: 'x', services: [] } });
    await client.listAccounts('a/b c');
    expect(calls[0]?.url).toBe(`${BASE}/api/app/projects/a%2Fb%20c/accounts`);
  });
});

describe('setAccountEnabled', () => {
  it('PUTs exactly the owner\'s intent', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, project_id: 'p1', services: SERVICES } });
    await client.setAccountEnabled('p1', { service: 'google_calendar', account_id: 'a2', enabled: true });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(`${BASE}/api/app/projects/p1/accounts`);
    // Not inverted, not remapped into an enable-list of ids.
    expect(calls[0]?.body).toEqual({ service: 'google_calendar', account_id: 'a2', enabled: true });
  });

  it('sends enabled:false verbatim when turning one OFF', async () => {
    const { client, calls } = make({ status: 200, body: { ok: true, project_id: 'p1', services: SERVICES } });
    await client.setAccountEnabled('p1', { service: 'google_calendar', account_id: 'a1', enabled: false });
    expect(calls[0]?.body).toEqual({ service: 'google_calendar', account_id: 'a1', enabled: false });
  });

  it('returns the WHOLE refreshed view, so the caller never patches a local copy', async () => {
    // Patching locally is precisely how a client drifts from a disable list.
    const { client } = make({ status: 200, body: { ok: true, project_id: 'p1', services: SERVICES } });
    const out = await client.setAccountEnabled('p1', {
      service: 'google_calendar',
      account_id: 'a2',
      enabled: true,
    });
    expect(out).toEqual(SERVICES);
  });
});

/**
 * The SCREEN is wired to the client — the half #501 was actually about.
 *
 * #501 was never an architecture gap: the server surface and the store were already
 * client-agnostic, and the selection is enforced at `CoreCredentialResolver`
 * regardless of which client set it. The gap was that no mobile UI was bound to any
 * of it, so a correct client with no screen behind it would close nothing.
 *
 * ASSERTED ON SOURCE, AND LABELLED WEAKER, per the precedent in Open #128. The
 * settings screen is an expo-router route that pulls the router, the session
 * provider and a live gateway client; mounting it is a materially bigger harness
 * than this change, and a half-built mount would be a test that passes without
 * exercising the path. Stated as a limitation rather than dressed up.
 */
// Read at MODULE scope, synchronously. An `await` inside a describe body silently
// DROPS the whole block in bun — the first version of this file did exactly that and
// the suite still reported 8 pass, with five tests simply absent. Checking the test
// COUNT, not just the failure count, is what caught it.
const SETTINGS_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'projects', '[id]', 'settings.tsx'),
  'utf8',
);

describe('the mobile settings screen renders the section', () => {
  it('calls both client methods', () => {
    // A screen that only listed would show the control and never apply it.
    expect(SETTINGS_SRC).toContain('.listAccounts(');
    expect(SETTINGS_SRC).toContain('.setAccountEnabled(');
  });

  it('renders from the state the server returned, not a locally-derived flag', () => {
    // `acct.enabled ?` is the render; anything computing enablement here would be
    // the inversion the client tests above forbid, moved up a layer.
    expect(SETTINGS_SRC).toContain('acct.enabled');
    expect(SETTINGS_SRC).toContain('!acct.enabled');
  });

  it('re-renders from the WHOLE view a toggle returns', () => {
    // Window sized to the real code (comments sit between the call and the
    // setState); the point is that the toggle's own resolution feeds setState,
    // not that the two lines are adjacent.
    expect(SETTINGS_SRC).toMatch(/setAccountEnabled\([\s\S]{0,900}?setAcctServices\(services\)/);
  });

  it('warns when every account for a service is off', () => {
    // Legal and reachable, but it starves the Core of every account, so it is named
    // rather than left looking like a rendering bug.
    expect(SETTINGS_SRC).toContain('every((a) => !a.enabled)');
  });

  it('guards a slow response with the same monotonic sequence the creds list uses', () => {
    // Without it a toggle resolving after a fresher refresh overwrites it.
    expect(SETTINGS_SRC).toContain('acctSeq');
  });
})
