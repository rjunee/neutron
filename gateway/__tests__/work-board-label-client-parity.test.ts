/**
 * THE ACK NAMES A BOARD. BOTH RAILS MUST CONTAIN A ROW ANSWERING TO THAT NAME.
 *
 * `disambiguateProjectBoardLabel` exists so a project named `General` is not printed
 * back to the owner as the same word as the General board. It is deliberately a
 * SERVER-SIDE rule with exactly one implementation — but "one rule" is only worth
 * anything if it reaches every surface, and the two rails read the project set over
 * DIFFERENT transports:
 *
 *   - WEB takes the `projects_changed` app-ws frame, whose `label` field
 *     `open/composer.ts` `readProjectRows` has always computed;
 *   - MOBILE lists over `GET /api/app/projects`, which carried NO label at all and so
 *     rendered `projects.name` raw.
 *
 * That asymmetry shipped once already, underneath an as-built paragraph asserting that
 * "BOTH clients render it verbatim, so this fix needs no web/mobile change". The claim
 * was about the design; the code only did half of it. On a phone the ack therefore named
 * a board that no rail row answered to — the exact indistinguishability the rule was
 * written to remove, reintroduced by the transport that the doc forgot.
 *
 * A prose assertion of parity is what failed. This file is the replacement.
 *
 * WHY IT LIVES IN `gateway/__tests__`: `landing` does not declare `@neutronai/app` and
 * must not start; `gateway` is the one package that declares BOTH. Same home and
 * reasoning as `usage-dashboard-client-parity.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { disambiguateProjectBoardLabel, PROJECT_BOARD_SUFFIX } from '@neutronai/work-board/chat-ack.ts'
import { fetchProjects } from '@neutronai/app/lib/projects'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const read = (...parts: string[]): string => readFileSync(join(REPO_ROOT, ...parts), 'utf8')

/** The one name in the product that collides with the General board. */
const COLLIDING_NAME = 'General'

/**
 * A `GET /api/app/projects` body shaped exactly as
 * `gateway/http/app-projects-surface.ts` `handleList` builds it — including the
 * server-computed `label`, produced HERE by the PRODUCTION function rather than by a
 * hand-typed string, so this fixture cannot drift away from the rule it is standing in
 * for. (A literal `'General (project)'` here would keep passing after someone changed
 * the rule, which is the whole failure mode.)
 */
function listBody(name: string): string {
  return JSON.stringify({
    ok: true,
    project_slug: 'owner',
    projects: [
      {
        id: 'example-project',
        name,
        label: disambiguateProjectBoardLabel(name),
        description: '',
        persona: '',
        emoji: '📁',
        privacy_mode: 'private',
        billing_mode: 'personal',
        agent_engagement_mode: 'mentions',
        members: [],
        last_activity_at: '',
        unread_count: 0,
        kind: 'solo',
        origin_instance: 'owner',
        owning_instance_slug: 'owner',
      },
    ],
    source_errors: [],
  })
}

const REAL_FETCH: typeof globalThis.fetch = globalThis.fetch

/** Serve one canned list body to the production `fetchProjects` path. */
async function withListBody<T>(body: string, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

async function fetchOne(name: string): Promise<{ name: string; label: string }> {
  return await withListBody(listBody(name), async () => {
    const got = await fetchProjects({
      base_url: 'https://instance.example.com',
      token: 't',
      now: 1_700_000_000_000,
    })
    const p = got.projects[0]!
    return { name: p.name, label: p.label }
  })
}

describe('the board label reaches BOTH rails', () => {
  test('the mobile list mapper surfaces the server label, and keeps `name` raw', async () => {
    const got = await fetchOne(COLLIDING_NAME)
    // The label is disambiguated...
    expect(got.label).toBe(disambiguateProjectBoardLabel(COLLIDING_NAME))
    expect(got.label).not.toBe(COLLIDING_NAME)
    // ...and the raw name survives beside it, because the settings drawer's rename
    // field round-trips `name` and must not be seeded with the qualifier.
    expect(got.name).toBe(COLLIDING_NAME)
  })

  test('a NON-colliding name is passed through identically on both fields', async () => {
    const got = await fetchOne('Example Project')
    expect(got.label).toBe('Example Project')
    expect(got.name).toBe('Example Project')
  })

  test('an older gateway that omits `label` degrades to the raw name, never to blank', async () => {
    const body = JSON.parse(listBody(COLLIDING_NAME)) as {
      projects: Array<Record<string, unknown>>
    }
    delete body.projects[0]!['label']
    const got = await withListBody(JSON.stringify(body), () =>
      fetchProjects({
        base_url: 'https://instance.example.com',
        token: 't',
        now: 1_700_000_000_000,
      }),
    )
    expect(got.projects[0]!.label).toBe(COLLIDING_NAME)
  })
})

describe('neither client owns a copy of the rule', () => {
  /**
   * The qualifier is a SERVER string. A client that spells it is a second
   * implementation, and a second implementation is what drifts — which is the
   * failure this whole change is about, one level up.
   */
  test('the qualifier appears in no client source', () => {
    const clientSources = [
      read('app', 'app', 'projects', '[id]', '_layout.tsx'),
      read('app', 'lib', 'projects.ts'),
      read('app', 'lib', 'project-rail-view.ts'),
      read('landing', 'chat-react', 'ChatApp.tsx'),
    ]
    for (const src of clientSources) {
      expect(src.includes(PROJECT_BOARD_SUFFIX)).toBe(false)
    }
  })

  /**
   * And each rail renders the LABEL rather than the raw name. Structural, because the
   * render itself needs a mounted RN tree the app suite never builds — but pinned
   * against the production files, so deleting the mapping fails here.
   */
  test('the mobile rail maps `label` into the rail row', () => {
    const layout = read('app', 'app', 'projects', '[id]', '_layout.tsx')
    expect(/name:\s*p\.label/.test(layout)).toBe(true)
    // And not the raw name — the regression this test exists to catch.
    expect(/name:\s*p\.name/.test(layout)).toBe(false)
  })

  test('the web rail renders the frame label', () => {
    const chatApp = read('landing', 'chat-react', 'ChatApp.tsx')
    expect(chatApp.includes('p.label')).toBe(true)
  })

  test('the HTTP list surface computes the label through the shared rule', () => {
    const surface = read('gateway', 'http', 'app-projects-surface.ts')
    expect(surface.includes('disambiguateProjectBoardLabel')).toBe(true)
    // BOTH halves of the list — solo and shared. A shared project named `General` is
    // exactly as indistinguishable as a local one.
    const calls = surface.match(/disambiguateProjectBoardLabel\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})
