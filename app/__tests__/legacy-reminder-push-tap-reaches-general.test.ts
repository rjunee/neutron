/**
 * @neutronai/app — a legacy reminder push tap must land on real reminders.
 *
 * THE UNION, NOT THE HALVES. `resolvePushRoute` was green and `RemindersClient` was
 * green, and the path between them was broken: the resolver emits the mobile RAIL
 * spelling of the no-project scope (`~general`), expo-router hands that segment to
 * the Reminders screen verbatim, the screen passes it to the client as `project_id`,
 * and the client interpolated it straight into `/api/app/projects/<id>/reminders`.
 * The gateway's `sanitizeProjectId` rejects `~` (outside its `[A-Za-z0-9_.-]`
 * alphabet), so the owner's tap opened the app and showed him `invalid_project_id`
 * where his reminders should be.
 *
 * That is the same shape as the defect this whole change exists to fix — a sender
 * and a resolver each independently correct, disagreeing at the seam
 * (`wire-types/push-kind.ts` records the original). So this walks the REAL resolver
 * output into the REAL client and asserts on the URL that would actually go over the
 * wire. Neither module's own suite can see this, because neither one is wrong.
 *
 * WHICH WAY THE SEAM WAS CLOSED CHANGED, and this file's assertions changed with it
 * (2026-08-11). The first fix collapsed the sentinel to the literal segment
 * `general`, and these tests pinned that the tilde must NOT reach the wire. But
 * `general` is a legal project id, so on an instance that HAS a project of that name
 * the General scope and that project addressed ONE server-side topic — sharing a
 * list and, once this client adopted the mapping, sharing create / snooze / cancel
 * too. So the SERVER learned the sentinel instead
 * (`gateway/http/app-reminders-surface.ts` `resolveScopeSegment`), and the tilde
 * reaching the wire is now the CORRECT outcome rather than the bug. What has to hold
 * is that both ends spell it the same way, which is what the pin below asserts
 * against `wire-types`, the one definition each side imports.
 *
 * WHY THE LEGACY KIND STILL MATTERS. `reminder` has no sender left — the live
 * notification is `agent_message` and routes to chat. But a store-published app and
 * a self-hosted gateway do not upgrade together, so this decoder still runs for
 * notifications already sitting in the shade and for un-upgraded gateways. A tap on
 * one of those is exactly the owner's *"it opened the app but not the right
 * project"*, and it has to land somewhere true.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts';

import { GENERAL_HTTP_ID, RAIL_GENERAL_ID } from '../lib/general-scope';
import { resolvePushRoute } from '../lib/push-deep-link-dispatch';
import { RemindersClient } from '../lib/reminders-client';

const originalFetch: typeof globalThis.fetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Records the URL the client asks for and answers with an empty pending list. */
function captureUrls(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(typeof input === 'string' ? input : String(input));
    return new Response(JSON.stringify({ ok: true, reminders: [], project_id: 'general' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return urls;
}

/**
 * The project segment + query the Reminders screen receives, derived from a router
 * path the way expo-router derives it: split the path, percent-DECODE the segment.
 * Hand-writing `'~general'` here instead would be asserting against a fixture and
 * would have passed all along.
 */
function routeParams(path: string): { id: string; reminder_id: string | null } {
  const [pathname, query = ''] = path.split('?');
  const segments = pathname!.split('/').filter((s) => s.length > 0);
  // `/projects/<id>/reminders`
  expect(segments[0]).toBe('projects');
  expect(segments[2]).toBe('reminders');
  const reminder_id = new URLSearchParams(query).get('reminder_id');
  return { id: decodeURIComponent(segments[1]!), reminder_id };
}

describe('a legacy General reminder tap reaches the reminders API', () => {
  it('resolves to the rail spelling of General — the input the screen actually gets', () => {
    // Pinned so the rest of the test cannot silently start proving nothing: if the
    // resolver ever stops emitting the rail sentinel, the mapping below is no longer
    // the thing under test and this line says so.
    const path = resolvePushRoute({ kind: 'reminder', reminder_id: 'rem-1' }, { warn: () => {} });
    expect(path).toBe(`/projects/${RAIL_GENERAL_ID}/reminders?reminder_id=rem-1`);
    expect(routeParams(path!).id).toBe(RAIL_GENERAL_ID);
  });

  it('THE BLOCKER: the resolved route drives a request the gateway can answer', async () => {
    const urls = captureUrls();
    const path = resolvePushRoute({ kind: 'reminder', reminder_id: 'rem-1' }, { warn: () => {} });
    const params = routeParams(path!);

    const client = new RemindersClient({ base_url: 'https://box.example.com', token: 't' });
    await client.list(params.id, { include_id: params.reminder_id });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      `https://box.example.com/api/app/projects/${GENERAL_RAIL_ID}` +
        '/reminders?status=pending&include_id=rem-1',
    );
    // THE SEGMENT ON THE WIRE IS THE ONE THE SERVER RESERVES, asserted against
    // `wire-types` rather than against a literal — that module is the single
    // definition `gateway/http/app-reminders-surface.ts` imports for its exact-match
    // reservation, so a drift in either copy reds here instead of producing a 400 on
    // a device. The client's own constant is pinned to the same value in
    // `general-scope.test.ts`.
    expect(urls[0]).toContain(`/projects/${GENERAL_RAIL_ID}/`);
    // NOT `%7E`, and that distinction is load-bearing in BOTH regimes: `~` is an
    // UNRESERVED character, so `encodeURIComponent('~general')` returns it unchanged.
    // Under the old collapse-to-`general` fix that property is what made the bug
    // invisible to every "does it encode the segment?" test; under the reservation it
    // is what lets the sentinel arrive intact for an exact-match compare.
    expect(urls[0]).not.toContain('%7E');
    // And the collapsed spelling must NOT appear — that value is a legal project id,
    // and using it here is exactly the aliasing this fix removed.
    expect(urls[0]).not.toContain(`/projects/${GENERAL_HTTP_ID}/`);
  });

  it('every mutating call maps it too, not just the list', async () => {
    // The tap lands on a LIST, but the screen the tap opens then offers snooze,
    // cancel and convert-to-task on those rows. Fixing only the read would leave the
    // owner looking at his reminders and unable to touch any of them — and mapping
    // the writes onto the COLLIDING segment would be worse than leaving them broken,
    // because a cancel would land on a real project's row.
    const urls = captureUrls();
    const client = new RemindersClient({ base_url: 'https://box.example.com', token: 't' });
    await client.create(RAIL_GENERAL_ID, 'stand up', 1_800_000_000);
    await client.snooze(RAIL_GENERAL_ID, 'rem-1', 1_800_000_600);
    await client.cancel(RAIL_GENERAL_ID, 'rem-1');
    await client.convertToTask(RAIL_GENERAL_ID, 'rem-1');

    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(url).toContain(`/api/app/projects/${GENERAL_RAIL_ID}/reminders`);
      expect(url).not.toContain(`/projects/${GENERAL_HTTP_ID}/`);
    }
  });

  it('a project literally named `general` gets a DIFFERENT URL from the scope', async () => {
    // The reason the segment changed. Both of these used to be
    // `/api/app/projects/general/reminders`, so this project's reminders WERE the
    // General tab's reminders — including its cancels.
    const urls = captureUrls();
    const client = new RemindersClient({ base_url: 'https://box.example.com', token: 't' });
    await client.list(GENERAL_HTTP_ID);
    await client.list(RAIL_GENERAL_ID);
    expect(urls[0]).toBe(
      'https://box.example.com/api/app/projects/general/reminders?status=pending',
    );
    expect(urls[1]).toBe(
      'https://box.example.com/api/app/projects/~general/reminders?status=pending',
    );
    expect(urls[0]).not.toBe(urls[1]);
  });

  it('a real project id passes through untouched', async () => {
    // The mapping is an EXACT match on the sentinel, so a project of one's own is
    // never rewritten into the General scope.
    const urls = captureUrls();
    const client = new RemindersClient({ base_url: 'https://box.example.com', token: 't' });
    await client.list('beacon');
    expect(urls[0]).toBe(
      'https://box.example.com/api/app/projects/beacon/reminders?status=pending',
    );
  });

  it('a project-scoped legacy reminder still lands on ITS project', async () => {
    // The legacy payload carried a project only as `topic_id: 'app-project:<id>'`.
    // That decode is the reason the branch survives at all, so the union has to hold
    // for it as well as for General.
    const urls = captureUrls();
    const path = resolvePushRoute(
      { kind: 'reminder', reminder_id: 'rem-9', topic_id: 'app-project:beacon' },
      { warn: () => {} },
    );
    const params = routeParams(path!);
    expect(params.id).toBe('beacon');

    const client = new RemindersClient({ base_url: 'https://box.example.com', token: 't' });
    await client.list(params.id, { include_id: params.reminder_id });
    expect(urls[0]).toBe(
      'https://box.example.com/api/app/projects/beacon' +
        '/reminders?status=pending&include_id=rem-9',
    );
  });
});
