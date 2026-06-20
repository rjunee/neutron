/**
 * Sidebar topic-rail (2026-05-29 sprint) — DOM-level tests for the
 * `TopicRail` class in `landing/chat.ts`.
 *
 * The 2026-05-28 v1 sidebar shipped a 260px desktop column +
 * hamburger-toggled mobile drawer. Sam called that out as wrong
 * (verbatim: "I don't want this to render as a hamburger. I want
 * icons with small text like the telegram topics interface."). This
 * sprint replaces the drawer with an always-visible ~76px vertical
 * strip — circular avatar per row, 11px label below, deterministic
 * per-project colour, curated emoji glyph for known project name
 * patterns. CSS / HTML contract enforcement lives in
 * __tests__/sidebar-rail-visual.test.ts; this file owns the runtime
 * render behaviour.
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

interface RailHarness {
  rail: HTMLElement
  list: HTMLElement
  reloads: string[]
}

function mountRailDom(): RailHarness {
  document.body.innerHTML = `
    <aside id="topic-rail">
      <nav class="rail-list" id="rail-list">
        <button class="topic-row" data-topic-id="" data-topic="general" aria-current="page" data-fallback="true">
          <span class="topic-avatar">#<span class="topic-badge" hidden>0</span></span>
          <span class="topic-label">General</span>
        </button>
      </nav>
    </aside>
  `
  return {
    rail: document.getElementById('topic-rail') as HTMLElement,
    list: document.getElementById('rail-list') as HTMLElement,
    reloads: [],
  }
}

function makeFetchStub(payload: unknown, ok = true, status = 200): typeof fetch {
  return (async (_input: RequestInfo, _init?: RequestInit) => {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('TopicRail', () => {
  test('render with 1 General + 7 project topics → 8 rows + active state', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      fetchImpl: makeFetchStub({ ok: true, topics: [] }),
      reload: (target) => h.reloads.push(target),
    })
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      ...Array.from({ length: 7 }, (_, i) => ({
        topic_id: `web:u-1:proj-${i}`,
        project_id: `proj-${i}`,
        name: `Project ${i}`,
        last_body: `last body ${i}`,
        last_created_at: 1000 + i,
        unread_count: i,
      })),
    ])
    const rows = h.list.querySelectorAll('.topic-row')
    expect(rows.length).toBe(8)
    // General is first and marked active (activeTopicId === null).
    expect(rows[0]!.getAttribute('aria-current')).toBe('page')
    expect(rows[0]!.querySelector('.topic-label')!.textContent).toBe('General')
    // Project-1 has the right label + badge with unread_count.
    const proj1 = rows[2]!
    expect(proj1.querySelector('.topic-label')!.textContent).toBe('Project 1')
    expect(proj1.querySelector('.topic-badge')!.textContent).toBe('1')
    // Project-0 has unread_count=0 so its badge is hidden.
    const proj0Badge = rows[1]!.querySelector('.topic-badge') as HTMLElement
    expect(proj0Badge.hidden).toBe(true)
  })

  test('per-row layout is vertical: avatar precedes label as siblings inside the row', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      reload: () => {},
    })
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:proj-x', project_id: 'proj-x', name: 'Project X', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    const row = h.list.querySelectorAll('.topic-row')[1]!
    const children = Array.from(row.children) as HTMLElement[]
    // Exactly two top-level row children: avatar then label. The
    // badge lives INSIDE the avatar as a positioning child.
    expect(children.length).toBe(2)
    expect(children[0]!.classList.contains('topic-avatar')).toBe(true)
    expect(children[1]!.classList.contains('topic-label')).toBe(true)
    // The legacy v1 preview line is gone — no horizontal room for it
    // in the narrow strip.
    expect(row.querySelector('.topic-preview')).toBeNull()
    // The badge is a descendant of the avatar (Telegram pattern).
    const badge = row.querySelector('.topic-badge')
    expect(badge).not.toBeNull()
    expect(badge!.parentElement!.classList.contains('topic-avatar')).toBe(true)
  })

  test('General row is first + carries the `#` glyph and data-topic="general"', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      reload: () => {},
    })
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:proj-a', project_id: 'proj-a', name: 'Project A', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    const rows = h.list.querySelectorAll('.topic-row')
    expect(rows[0]!.getAttribute('data-topic')).toBe('general')
    // Strip the nested badge text to read just the avatar glyph.
    const avatar = rows[0]!.querySelector('.topic-avatar') as HTMLElement
    expect(avatar.firstChild!.textContent).toBe('#')
    // Project rows do NOT carry the data-topic="general" marker.
    expect(rows[1]!.getAttribute('data-topic')).toBeNull()
  })

  test('per-project avatar uses curated emoji glyph for known patterns; first-letter fallback otherwise', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      reload: () => {},
    })
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:home', project_id: 'home', name: 'Home Assistant', last_body: null, last_created_at: 1, unread_count: 0 },
      { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 2, unread_count: 0 },
      { topic_id: 'web:u-1:weird', project_id: 'weird', name: 'Quux Synthesis', last_body: null, last_created_at: 3, unread_count: 0 },
    ])
    const rows = h.list.querySelectorAll('.topic-row')
    const homeAvatar = rows[1]!.querySelector('.topic-avatar')!
    expect(homeAvatar.firstChild!.textContent).toBe('🏠')
    const tabsAvatar = rows[2]!.querySelector('.topic-avatar')!
    expect(tabsAvatar.firstChild!.textContent).toBe('🗂')
    // Unknown name → first uppercase letter.
    const weirdAvatar = rows[3]!.querySelector('.topic-avatar')!
    expect(weirdAvatar.firstChild!.textContent).toBe('Q')
  })

  test('per-project avatar colour is deterministic for the same project_id', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      reload: () => {},
    })
    const topics = [
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:proj-a', project_id: 'proj-a', name: 'Project A', last_body: null, last_created_at: 1, unread_count: 0 },
      { topic_id: 'web:u-1:proj-b', project_id: 'proj-b', name: 'Project B', last_body: null, last_created_at: 2, unread_count: 0 },
    ]
    rail.render(topics)
    const firstA = (h.list.querySelectorAll('.topic-row')[1]!.querySelector('.topic-avatar') as HTMLElement)
      .style.backgroundColor
    const firstB = (h.list.querySelectorAll('.topic-row')[2]!.querySelector('.topic-avatar') as HTMLElement)
      .style.backgroundColor
    // Same project_id renders the same colour across re-renders.
    rail.render(topics)
    const secondA = (h.list.querySelectorAll('.topic-row')[1]!.querySelector('.topic-avatar') as HTMLElement)
      .style.backgroundColor
    expect(secondA).toBe(firstA)
    // Two distinct project_ids should land on a non-empty hex string
    // each — we don't pin the exact colour (palette layout is an
    // implementation detail) but both must come from the palette
    // (non-empty inline style).
    expect(firstA.length).toBeGreaterThan(0)
    expect(firstB.length).toBeGreaterThan(0)
  })

  test('click on a project row persists to localStorage + reloads', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      fetchImpl: makeFetchStub({ ok: true, topics: [] }),
      reload: (target) => h.reloads.push(target),
    })
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:proj-a', project_id: 'proj-a', name: 'Project A', last_body: 'hi', last_created_at: 1, unread_count: 0 },
    ])
    const projectRow = h.list.querySelectorAll('.topic-row')[1] as HTMLElement
    projectRow.click()
    expect(localStorage.getItem(mod.ACTIVE_TOPIC_LS_KEY)).toBe('web:u-1:proj-a')
    expect(h.reloads.length).toBe(1)
    // Switching back to General clears the entry.
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:proj-a', project_id: 'proj-a', name: 'Project A', last_body: 'hi', last_created_at: 1, unread_count: 0 },
    ])
    const generalRow = h.list.querySelectorAll('.topic-row')[0] as HTMLElement
    generalRow.click()
    expect(localStorage.getItem(mod.ACTIVE_TOPIC_LS_KEY)).toBeNull()
    expect(h.reloads.length).toBe(2)
  })

  test('hydrate() failure leaves the static fallback row visible', async () => {
    const h = mountRailDom()
    const fallbackBefore = h.list.querySelector('.topic-row[data-fallback="true"]')
    expect(fallbackBefore).not.toBeNull()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: null,
      // Simulate a 404 from an unmounted topics endpoint.
      fetchImpl: (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch,
      reload: () => {},
    })
    await rail.hydrate()
    // The static fallback row should still be in the DOM.
    const fallbackAfter = h.list.querySelector('.topic-row[data-fallback="true"]')
    expect(fallbackAfter).not.toBeNull()
  })

  test('readActiveTopicId / writeActiveTopicId round-trip', () => {
    localStorage.removeItem(mod.ACTIVE_TOPIC_LS_KEY)
    expect(mod.readActiveTopicId()).toBeNull()
    mod.writeActiveTopicId('web:u-1:proj-x')
    expect(mod.readActiveTopicId()).toBe('web:u-1:proj-x')
    mod.writeActiveTopicId(null)
    expect(mod.readActiveTopicId()).toBeNull()
  })

  test('topicAvatarChar picks first letter and uppercases; empty falls back', () => {
    expect(mod.topicAvatarChar('Northwind Labs')).toBe('N')
    expect(mod.topicAvatarChar('acme')).toBe('A')
    expect(mod.topicAvatarChar('')).toBe('★')
    expect(mod.topicAvatarChar('   ')).toBe('★')
  })

  test('topicGlyph maps curated patterns to emoji; unknown names fall back to first letter', () => {
    expect(mod.topicGlyph('Home Assistant')).toBe('🏠')
    expect(mod.topicGlyph('Topline')).toBe('🗂')
    expect(mod.topicGlyph('Northwind Labs')).toBe('🧪')
    expect(mod.topicGlyph('n8n Automation')).toBe('⚙️')
    expect(mod.topicGlyph('LA Property')).toBe('🏡')
    expect(mod.topicGlyph('Helperbot')).toBe('🤖')
    // Unknown — first uppercase letter.
    expect(mod.topicGlyph('Quux Synthesis')).toBe('Q')
    // Empty falls through to the topicAvatarChar fallback.
    expect(mod.topicGlyph('')).toBe('★')
  })

  test('topicAvatarColor is deterministic + non-empty for any seed; empty seed → neutral', () => {
    const a1 = mod.topicAvatarColor('proj-a')
    const a2 = mod.topicAvatarColor('proj-a')
    expect(a1).toBe(a2)
    expect(a1.startsWith('#')).toBe(true)
    expect(a1.length).toBe(7)
    const empty = mod.topicAvatarColor('')
    expect(empty).toBe('#2b3037')
  })

  test('activeTopicId === topic_id flags the matching row as aria-current=page', () => {
    const h = mountRailDom()
    const rail = new mod.TopicRail({
      rail: h.rail,
      list: h.list,
      activeTopicId: 'web:u-1:proj-b',
      fetchImpl: makeFetchStub({ ok: true, topics: [] }),
      reload: () => {},
    })
    rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:proj-a', project_id: 'proj-a', name: 'A', last_body: null, last_created_at: 1, unread_count: 0 },
      { topic_id: 'web:u-1:proj-b', project_id: 'proj-b', name: 'B', last_body: null, last_created_at: 2, unread_count: 0 },
    ])
    const rows = h.list.querySelectorAll('.topic-row')
    expect(rows[0]!.getAttribute('aria-current')).toBeNull()
    expect(rows[1]!.getAttribute('aria-current')).toBeNull()
    expect(rows[2]!.getAttribute('aria-current')).toBe('page')
  })
})
