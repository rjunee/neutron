/**
 * Item 6 (2026-06-19, owner live-dogfood) — sidebar live-refresh.
 *
 * On a fresh page RELOAD the projects appear (the topics surface + rail
 * render work). The bug was purely LIVE: when onboarding finalized the
 * projects server-side, the client never re-fetched the rail, so the
 * sidebar stayed empty until a manual reload. `TopicRail.refreshIfNoProjects()`
 * (wired to the ChatClient's post-agent-message hook) re-fetches WHILE no
 * project row has appeared, and self-guards to stop once they do.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let mod: typeof import('../chat.ts')

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 0
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  mod = await import('../chat.ts')
})

function mountRailDom(): { rail: HTMLElement; list: HTMLElement } {
  document.body.innerHTML = `
    <aside id="topic-rail">
      <nav class="rail-list" id="rail-list"></nav>
    </aside>
  `
  return {
    rail: document.getElementById('topic-rail') as HTMLElement,
    list: document.getElementById('rail-list') as HTMLElement,
  }
}

const GENERAL_ONLY = [
  { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
]
const GENERAL_PLUS_PROJECTS = [
  ...GENERAL_ONLY,
  { topic_id: 'web:u-1:p0', project_id: 'p0', name: 'Acme', last_body: null, last_created_at: 1, unread_count: 0 },
  { topic_id: 'web:u-1:p1', project_id: 'p1', name: 'Globex', last_body: null, last_created_at: 2, unread_count: 0 },
]

/** Fetch stub whose payload can change between calls; counts invocations. */
function makeCountingFetch(): { fetch: typeof fetch; calls: () => number; set: (topics: unknown[]) => void } {
  let count = 0
  let topics: unknown[] = GENERAL_ONLY
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ ok: true, topics }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  return {
    fetch: ((...args: unknown[]) => {
      count += 1
      return (fetchImpl as (...a: unknown[]) => unknown)(...args)
    }) as unknown as typeof fetch,
    calls: () => count,
    set: (t) => {
      topics = t
    },
  }
}

describe('TopicRail.refreshIfNoProjects — live sidebar refresh (Item 6)', () => {
  test('re-fetches while empty, renders projects when they appear, then stops', async () => {
    const h = mountRailDom()
    const f = makeCountingFetch()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      fetchImpl: f.fetch,
      reload: () => {},
    })
    // Initial mount hydrate: General only, no project rows yet.
    await rail.hydrate()
    expect(f.calls()).toBe(1)
    expect(h.list.querySelectorAll('.topic-row[data-project-id]').length).toBe(0)

    // An agent message arrives but projects still not created → nudge
    // re-fetches (still General-only).
    await rail.refreshIfNoProjects()
    expect(f.calls()).toBe(2)
    expect(h.list.querySelectorAll('.topic-row[data-project-id]').length).toBe(0)

    // Onboarding finalizes the projects server-side. The next nudge picks
    // them up LIVE — no manual reload.
    f.set(GENERAL_PLUS_PROJECTS)
    await rail.refreshIfNoProjects()
    expect(f.calls()).toBe(3)
    expect(h.list.querySelectorAll('.topic-row[data-project-id]').length).toBe(2)

    // Projects are now present → further nudges no-op (no extra fetches).
    await rail.refreshIfNoProjects()
    await rail.refreshIfNoProjects()
    expect(f.calls()).toBe(3)
  })
})
