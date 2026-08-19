/**
 * The General scope's HTTP spelling — one mapping, and the clients that USE it.
 *
 * THE DEFECT (owner-reported on device, 2026-08-09, one screenshot showing what
 * looked like two unrelated bugs): in General, the Docs tab rendered the raw
 * validator string `invalid_project_id: project_id must be 1-128 chars from
 * [A-Za-z0-9_.-]`, and the tab bar showed the legacy Chat/Apps/Tasks/Reminders/
 * Docs/Settings set with no Work tab and Docs in fifth place.
 *
 * ONE root cause. The mobile rail spells General `'~general'`, deliberately
 * outside the gateway's project-id alphabet, and two clients sent it RAW:
 *   - the docs client → 400, rendered as the validator string, and
 *   - the tabs client → 400, which the layout SWALLOWS by design, so General
 *     silently kept the pre-fetch loading default forever. The order was never
 *     an ordering bug; it was a failed fetch.
 *
 * WHY THE ASSERTIONS BELOW ARE ON FETCHED URLs, NOT ON THE MAPPER. A test that
 * only checks `httpProjectSegment('~general') === 'general'` passes with every
 * client still sending the raw sentinel — which is exactly the state that
 * shipped. The mapper had ALREADY existed twice (work-board, activity) while both
 * of these were broken. So each client is driven with an injected/stubbed fetch
 * and the URL it actually requests is asserted.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import {
  GENERAL_HTTP_ID,
  RAIL_GENERAL_ID,
  httpProjectSegment,
  httpProjectSegmentEncoded,
  httpScopeSegment,
  httpScopeSegmentEncoded,
} from '../lib/general-scope'
import { RemindersClient } from '../lib/reminders-client'
import { GENERAL_PROJECT_ID } from '../lib/project-rail-view'
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import { GENERAL_WORK_BOARD_PROJECT_ID, workBoardPathSegment } from '../lib/work-board-client'
import { GENERAL_ACTIVITY_SCOPE, activityScopeKey } from '../lib/activity-client'
import { DocsClient } from '../lib/docs-client'
import { TabsClient } from '../lib/tabs-client'

describe('the one mapping', () => {
  test('the duplicated sentinel matches the rail it stands for', () => {
    // `general-scope.ts` is import-free ON PURPOSE (every consumer is an RN-free
    // client that must not gain the rail-view import chain), so the constant is
    // duplicated. This is the pin that stops the copy drifting.
    expect(RAIL_GENERAL_ID).toBe(GENERAL_PROJECT_ID)
  })

  test('the GATEWAY spells General the same way — a push payload names this scope', () => {
    // 2026-08-09: the sentinel is now spoken on BOTH sides of the wire. A
    // chat-message notification for a General-scope post carries `project_id`
    // set to this string, and the tap resolver turns it back into the route. If
    // the gateway's copy and the rail's copy ever differ, the tap lands on a
    // project that does not exist — silently, because both halves stay green on
    // their own. `wire-types` holds the definition; this is the pin that proves
    // the client did not fork it.
    expect(GENERAL_RAIL_ID).toBe(GENERAL_PROJECT_ID)
  })

  test('every client-side spelling of General collapses to the server id', () => {
    expect(httpProjectSegment(RAIL_GENERAL_ID)).toBe(GENERAL_HTTP_ID)
    expect(httpProjectSegment('')).toBe(GENERAL_HTTP_ID)
    expect(httpProjectSegment(null)).toBe(GENERAL_HTTP_ID)
    expect(httpProjectSegment(undefined)).toBe(GENERAL_HTTP_ID)
  })

  test('a named project passes through — including one literally named "general"', () => {
    expect(httpProjectSegment('tabs')).toBe('tabs')
    expect(httpProjectSegment(GENERAL_HTTP_ID)).toBe(GENERAL_HTTP_ID)
  })

  test('THAT PASS-THROUGH IS THE COLLISION: the scope and a real "general" alias', () => {
    // Stated as an assertion rather than a comment so the defect cannot be
    // rediscovered as a surprise. `httpProjectSegment` cannot tell the no-project
    // scope from a project whose id happens to be `general`, because the segment it
    // maps General onto is itself a legal project id. Four surfaces still share this
    // — #183 — and TWO OF THEM MUTATE through it (`docs-client.ts` writes and deletes
    // documents, `work-board-client.ts` creates, patches and deletes items), so #183
    // is an open wrong-scope WRITE, not a read-only wart. The pin below is what stops
    // the surface that HAS been split off from rejoining them by a copy-paste.
    expect(httpProjectSegment(RAIL_GENERAL_ID)).toBe(httpProjectSegment(GENERAL_HTTP_ID))
  })

  test('httpScopeSegment KEEPS the sentinel, so the scope and that project diverge', () => {
    // The whole point: `~` is outside the gateway's project-id alphabet, so these two
    // values can never be equal no matter what a project is called.
    expect(httpScopeSegment(RAIL_GENERAL_ID)).toBe(RAIL_GENERAL_ID)
    expect(httpScopeSegment(GENERAL_HTTP_ID)).toBe(GENERAL_HTTP_ID)
    expect(httpScopeSegment(RAIL_GENERAL_ID)).not.toBe(httpScopeSegment(GENERAL_HTTP_ID))
    // Every other client-side spelling of General collapses onto the sentinel.
    expect(httpScopeSegment('')).toBe(RAIL_GENERAL_ID)
    expect(httpScopeSegment(null)).toBe(RAIL_GENERAL_ID)
    expect(httpScopeSegment(undefined)).toBe(RAIL_GENERAL_ID)
    // A named project is untouched, and the match is exact, not a prefix.
    expect(httpScopeSegment('tabs')).toBe('tabs')
    expect(httpScopeSegment('~generalize')).toBe('~generalize')
  })

  test('the scope segment survives encoding — `~` is unreserved, so no %7E', () => {
    // If `encodeURIComponent` touched `~` the reserved segment would arrive as `%7E…`
    // and the server's exact-match reservation would miss it, falling through to
    // `sanitizeProjectId` and 400ing. That is the `#general` → `%23` failure of #411
    // repeated, so it is pinned rather than assumed.
    expect(httpScopeSegmentEncoded(RAIL_GENERAL_ID)).toBe(RAIL_GENERAL_ID)
    expect(httpScopeSegmentEncoded('')).toBe(RAIL_GENERAL_ID)
    expect(httpScopeSegmentEncoded('a b')).toBe('a%20b')
  })

  test('the match is EXACT, so a project merely starting with the sentinel survives', () => {
    // A prefix test here would silently redirect a real project's docs at the
    // General root — a data-visibility bug, not a 400.
    expect(httpProjectSegment('~generalize')).toBe('~generalize')
    expect(httpProjectSegment('~general-2')).toBe('~general-2')
  })

  test('the encoded form encodes AFTER mapping, never the sentinel', () => {
    expect(httpProjectSegmentEncoded(RAIL_GENERAL_ID)).toBe(GENERAL_HTTP_ID)
    expect(httpProjectSegmentEncoded('a b')).toBe('a%20b')
  })

  test('the two clients that already had their own copy still behave identically', () => {
    // Both delegate now; these pin the public names their callers use.
    expect(workBoardPathSegment(RAIL_GENERAL_ID)).toBe(GENERAL_WORK_BOARD_PROJECT_ID)
    expect(workBoardPathSegment('tabs')).toBe('tabs')
    expect(activityScopeKey(RAIL_GENERAL_ID)).toBe(GENERAL_ACTIVITY_SCOPE)
    expect(activityScopeKey('tabs')).toBe('tabs')
    expect(GENERAL_WORK_BOARD_PROJECT_ID).toBe(GENERAL_HTTP_ID)
    expect(GENERAL_ACTIVITY_SCOPE).toBe(GENERAL_HTTP_ID)
  })
})

/** Record every requested URL; answer with `body`. */
function recordingFetch(urls: string[], body: unknown): (input: string) => Promise<Response> {
  return async (input: string) => {
    urls.push(input)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('DocsClient asks for General by a name the server can spell', () => {
  const opts = (urls: string[], body: unknown) => ({
    base_url: 'https://example.test',
    token: 't',
    fetchImpl: recordingFetch(urls, body),
  })

  test('tree() on the rail sentinel requests /projects/general/docs/tree', async () => {
    const urls: string[] = []
    const client = new DocsClient(opts(urls, { ok: true, tree: [], file_count: 0 }))
    await client.tree(RAIL_GENERAL_ID)
    expect(urls[0]).toBe('https://example.test/api/app/projects/general/docs/tree')
    // The sentinel must not survive anywhere in the URL, encoded or raw — a
    // percent-encoded `~` would 400 just the same.
    expect(urls[0]).not.toContain('~')
    expect(urls[0]).not.toContain('%7E')
  })

  test('a write path maps too — the bug was not read-only', async () => {
    const urls: string[] = []
    const client = new DocsClient(opts(urls, { ok: true, file: { path: 'a.md', content: '' } }))
    await client.writeFile(RAIL_GENERAL_ID, { path: 'a.md', content: 'hello' })
    expect(urls[0]).toBe('https://example.test/api/app/projects/general/docs/file')
  })

  test('a named project is still requested under its own id', async () => {
    const urls: string[] = []
    const client = new DocsClient(opts(urls, { ok: true, tree: [], file_count: 0 }))
    await client.tree('tabs')
    expect(urls[0]).toBe('https://example.test/api/app/projects/tabs/docs/tree')
  })

  test('EVERY docs path builder goes through the mapper, not just the ones above', () => {
    // A source-scoped assertion, and labelled weaker on purpose: there are 21
    // path builders in the client and driving all 21 through a stub asserts the
    // same one fact 21 times. What matters is that no builder reaches for
    // `encodeURIComponent(project_id)` directly again — that is the mistake, and
    // it is textual. The three behavioural cases above prove the mapper is the
    // thing wired in.
    const src = Bun.file(new URL('../lib/docs-client.ts', import.meta.url)).text()
    return src.then((text) => {
      expect(text).not.toContain('encodeURIComponent(project_id)')
      expect(text).toContain('httpProjectSegmentEncoded')
    })
  })
})

describe('TabsClient asks for General by a name the server can spell', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('listProjectTabs on the rail sentinel requests /projects/general/tabs', async () => {
    const urls: string[] = []
    // TabsClient uses the global fetch (no injection seam), so stub it.
    globalThis.fetch = ((input: string) => {
      urls.push(String(input))
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, scope: 'project', tabs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch
    const client = new TabsClient({ base_url: 'https://example.test', token: 't' })
    await client.listProjectTabs(RAIL_GENERAL_ID)
    expect(urls[0]).toBe('https://example.test/api/app/projects/general/tabs')
  })
})

/**
 * THE MUTATING SURFACE ASKS FOR GENERAL BY A NAME NO PROJECT CAN HAVE.
 *
 * Asserted on requested URLs for the reason the header of this file gives: a test that
 * only checked the mapper would pass with the client still calling
 * `httpProjectSegmentEncoded`, which is the state that shipped and the state the review
 * caught. And EVERY method is driven, not a representative one — the finding was
 * specifically that create / snooze / cancel crossed the seam, so a suite that covered
 * `list()` alone would leave the writes untested while reading as coverage.
 */
describe('RemindersClient keeps General distinct from a project called "general"', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Every URL the client requested, in order. */
  function captureFetch(urls: string[]): void {
    globalThis.fetch = ((input: string) => {
      urls.push(String(input))
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, reminders: [], project_id: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch
  }

  function client(): RemindersClient {
    return new RemindersClient({ base_url: 'https://example.test', token: 't' })
  }

  /** Drive all five methods for one scope id and return the segments requested. */
  async function segmentsFor(project_id: string): Promise<string[]> {
    const urls: string[] = []
    captureFetch(urls)
    const c = client()
    await c.list(project_id)
    await c.create(project_id, 'water the plants', 1_800_000_000)
    await c.snooze(project_id, 'r1', 1_800_000_100)
    await c.cancel(project_id, 'r1')
    await c.convertToTask(project_id, 'r1')
    expect(urls).toHaveLength(5)
    return urls.map((u) => {
      const seg = new URL(u).pathname.split('/')[4]
      if (seg === undefined) throw new Error(`no project segment in ${u}`)
      return decodeURIComponent(seg)
    })
  }

  test('the rail sentinel reaches the server INTACT, on the read and all four writes', async () => {
    expect(await segmentsFor(RAIL_GENERAL_ID)).toEqual([
      RAIL_GENERAL_ID,
      RAIL_GENERAL_ID,
      RAIL_GENERAL_ID,
      RAIL_GENERAL_ID,
      RAIL_GENERAL_ID,
    ])
  })

  test('a project literally named "general" is a DIFFERENT URL on every method', async () => {
    // The regression this suite exists for: before the fix both of these produced
    // `/api/app/projects/general/reminders`, so the General scope and this project
    // shared one list — and one create, one snooze, one cancel.
    const scope = await segmentsFor(RAIL_GENERAL_ID)
    const project = await segmentsFor(GENERAL_HTTP_ID)
    expect(project).toEqual([
      GENERAL_HTTP_ID,
      GENERAL_HTTP_ID,
      GENERAL_HTTP_ID,
      GENERAL_HTTP_ID,
      GENERAL_HTTP_ID,
    ])
    scope.forEach((s, i) => expect(s).not.toBe(project[i]))
  })

  test('an empty scope id means General here too, not a `//reminders` double slash', async () => {
    const urls: string[] = []
    captureFetch(urls)
    await client().list('')
    expect(urls[0]).toBe(
      `https://example.test/api/app/projects/${RAIL_GENERAL_ID}/reminders?status=pending`,
    )
  })

  test('EVERY reminders path builder goes through the SCOPE mapper', async () => {
    // Source-scoped and labelled weaker, exactly as the docs-client case above is: what
    // matters textually is that no builder reaches back for `httpProjectSegmentEncoded`,
    // whose General segment is the colliding one. The five behavioural cases prove the
    // wiring; this catches a sixth method added later with the wrong helper.
    const text = await Bun.file(new URL('../lib/reminders-client.ts', import.meta.url)).text()
    expect(text).not.toContain('httpProjectSegmentEncoded')
    expect(text).toContain('httpScopeSegmentEncoded')
    expect(text).not.toContain('encodeURIComponent(project_id)')
  })
})
