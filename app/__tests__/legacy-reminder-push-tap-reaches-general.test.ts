/**
 * @neutronai/app — a legacy reminder push tap must land on real reminders.
 *
 * THE UNION, NOT THE HALVES. `resolvePushRoute` was green and `RemindersClient` was
 * green, and the path between them was broken: the resolver emits the mobile RAIL
 * spelling of the no-project scope (`~general`), expo-router hands that segment to
 * the Reminders screen verbatim, the screen passes it to the client as `project_id`,
 * and the client used to interpolate it straight into
 * `/api/app/projects/<id>/reminders`. The gateway's `sanitizeProjectId` rejects `~`
 * (outside its `[A-Za-z0-9_.-]` alphabet), so the owner's tap opened the app and
 * showed him `invalid_project_id` where his reminders should be.
 *
 * That is the same shape as the defect this whole change exists to fix — a sender
 * and a resolver each independently correct, disagreeing at the seam
 * (`wire-types/push-kind.ts` records the original). So this walks the REAL resolver
 * output into the REAL client and asserts on the URL that would actually go over the
 * wire. Neither module's own suite can see this, because neither one is wrong.
 *
 * WHY THE LEGACY KIND STILL MATTERS. `reminder` has no sender left — the live
 * notification is `agent_message` and routes to chat. But a store-published app and
 * a self-hosted gateway do not upgrade together, so this decoder still runs for
 * notifications already sitting in the shade and for un-upgraded gateways. A tap on
 * one of those is exactly the owner's *"it opened the app but not the right
 * project"*, and it has to land somewhere true.
 */

import { afterEach, describe, expect, it } from 'bun:test';

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
      `https://box.example.com/api/app/projects/${GENERAL_HTTP_ID}` +
        '/reminders?status=pending&include_id=rem-1',
    );
    // MUTATION-SENSITIVE (verified by reverting `reminders-client.ts` to a raw
    // `encodeURIComponent(project_id)`: this line reds with `/projects/~general/`).
    //
    // It asserts the raw sentinel, NOT `%7E`, and that distinction is the whole
    // hazard: `~` is an UNRESERVED character, so `encodeURIComponent('~general')`
    // returns `~general` unchanged. The tilde survives encoding intact and arrives at
    // a gateway validator that rejects it — which is why the bug was invisible to
    // every "does it encode the segment?" test, including the one already in
    // `reminders-client.test.ts`.
    expect(urls[0]).not.toContain(RAIL_GENERAL_ID);
  });

  it('every mutating call maps it too, not just the list', async () => {
    // The tap lands on a LIST, but the screen the tap opens then offers snooze,
    // cancel and convert-to-task on those rows. Fixing only the read would leave the
    // owner looking at his reminders and unable to touch any of them.
    const urls = captureUrls();
    const client = new RemindersClient({ base_url: 'https://box.example.com', token: 't' });
    await client.create(RAIL_GENERAL_ID, 'stand up', 1_800_000_000);
    await client.snooze(RAIL_GENERAL_ID, 'rem-1', 1_800_000_600);
    await client.cancel(RAIL_GENERAL_ID, 'rem-1');
    await client.convertToTask(RAIL_GENERAL_ID, 'rem-1');

    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(url).toContain(`/api/app/projects/${GENERAL_HTTP_ID}/reminders`);
      expect(url).not.toContain(RAIL_GENERAL_ID);
    }
  });

  it('a real project id passes through untouched', async () => {
    // The mapping is an EXACT match on the sentinel, so a project of one's own —
    // including one named `general` — is not rewritten into the General scope.
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
