/**
 * WAVE 3 PR-1 — tab-resolver unit tests.
 *
 * Verifies the engine-side builtin tab resolver (`tabs/registry.ts`):
 * descriptor shape, scope filtering, ordering, immutability of the shared
 * builtin set, and the v2-readiness invariants (no `'core'`/`'custom'`
 * source emitted in v1; `order` gaps left for PR-2 core-tab interleaving).
 */

import { describe, expect, it } from 'bun:test'

import {
  resolveGlobalTabs,
  resolveProjectTabs,
  resolveTabs,
  type CoreTabContribution,
  type TabDescriptor,
} from '../registry.ts'

describe('tab registry — project scope', () => {
  it('returns the builtin project tabs in order', () => {
    const tabs = resolveProjectTabs()
    // Tasks is NOT a builtin (Ryan directive — Core-contributed, WAVE 3); the
    // work_board tab's user-facing label reads "Plan".
    expect(tabs.map((t) => t.key)).toEqual(['chat', 'work_board', 'documents'])
    expect(tabs.map((t) => t.label)).toEqual(['Chat', 'Plan', 'Documents'])
  })

  it('marks every project tab scope=project, source=builtin, mount.kind=builtin', () => {
    for (const t of resolveProjectTabs()) {
      expect(t.scope).toBe('project')
      expect(t.source).toBe('builtin')
      expect(t.mount.kind).toBe('builtin')
      expect(typeof t.mount.target).toBe('string')
      expect(t.mount.target.length).toBeGreaterThan(0)
      // No core tab leaks into v1 — core_slug is reserved for PR-2.
      expect(t.core_slug).toBeUndefined()
    }
  })

  it('maps builtin keys to their existing client route targets', () => {
    const byKey = Object.fromEntries(resolveProjectTabs().map((t) => [t.key, t.mount.target]))
    expect(byKey['chat']).toBe('chat')
    expect(byKey['work_board']).toBe('workboard')
    expect(byKey['documents']).toBe('docs')
    expect(byKey['tasks']).toBeUndefined()
  })

  it('orders ascending by `order` with gaps left for PR-2 core tabs', () => {
    const orders = resolveProjectTabs().map((t) => t.order)
    // strictly ascending
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]!).toBeGreaterThan(orders[i - 1]!)
    }
    // gaps > 1 so a Core tab can slot BETWEEN builtins without renumbering
    expect(orders).toEqual([0, 5, 10])
  })
})

describe('tab registry — global scope', () => {
  it('returns only the builtin Admin global tab in v1', () => {
    const tabs = resolveGlobalTabs()
    expect(tabs).toHaveLength(1)
    const admin = tabs[0]!
    expect(admin.key).toBe('admin')
    expect(admin.label).toBe('Admin')
    expect(admin.scope).toBe('global')
    expect(admin.source).toBe('builtin')
    expect(admin.mount).toEqual({ kind: 'builtin', target: 'admin' })
  })

  it('never returns a project-scoped tab in the global set (and vice versa)', () => {
    expect(resolveGlobalTabs().every((t) => t.scope === 'global')).toBe(true)
    expect(resolveProjectTabs().every((t) => t.scope === 'project')).toBe(true)
  })
})

describe('tab registry — resolveTabs(scope) parity + immutability', () => {
  it('resolveTabs delegates identically to the convenience wrappers', () => {
    expect(resolveTabs('project')).toEqual(resolveProjectTabs())
    expect(resolveTabs('global')).toEqual(resolveGlobalTabs())
  })

  it('returns fresh objects every call — mutating one result cannot leak', () => {
    const first = resolveProjectTabs()
    // Mutate the returned descriptors aggressively.
    ;(first[0] as TabDescriptor).label = 'HACKED'
    ;(first[0] as TabDescriptor).mount.target = 'pwned'
    first.push({
      key: 'injected',
      label: 'x',
      scope: 'project',
      source: 'builtin',
      order: 999,
      mount: { kind: 'builtin', target: 'x' },
    })

    const second = resolveProjectTabs()
    expect(second.map((t) => t.key)).toEqual(['chat', 'work_board', 'documents'])
    expect(second[0]!.label).toBe('Chat')
    expect(second[0]!.mount.target).toBe('chat')
  })

  it('emits no v2 source values (core/custom) when no contributions are passed', () => {
    const all = [...resolveProjectTabs(), ...resolveGlobalTabs()]
    expect(all.every((t) => t.source === 'builtin')).toBe(true)
  })
})

describe('tab registry — Core union (PR-2)', () => {
  const notes: CoreTabContribution = {
    core_slug: 'notes',
    label: 'Notes',
    target: '/projects/p1/notes',
  }
  const calendar: CoreTabContribution = {
    core_slug: 'calendar',
    label: 'Calendar',
    target: '/projects/p1/calendar',
  }

  it('appends Core tabs AFTER the builtins, preserving install order', () => {
    const tabs = resolveProjectTabs([notes, calendar])
    expect(tabs.map((t) => t.key)).toEqual([
      'chat',
      'work_board',
      'documents',
      'core:notes',
      'core:calendar',
    ])
  })

  it('shapes a Core descriptor: source=core, core_slug set, webview mount', () => {
    const tab = resolveProjectTabs([notes]).find((t) => t.key === 'core:notes')!
    expect(tab.source).toBe('core')
    expect(tab.core_slug).toBe('notes')
    expect(tab.label).toBe('Notes')
    expect(tab.scope).toBe('project')
    expect(tab.mount).toEqual({ kind: 'webview', target: '/projects/p1/notes' })
    // Core tabs sort after the last builtin (documents, order=10).
    expect(tab.order).toBeGreaterThan(10)
  })

  it('unions Core tabs into the GLOBAL scope too (scope stamped global)', () => {
    const tabs = resolveGlobalTabs([{ ...notes, target: '/projects/<project_id>/notes' }])
    expect(tabs.map((t) => t.key)).toEqual(['admin', 'core:notes'])
    expect(tabs.find((t) => t.key === 'core:notes')!.scope).toBe('global')
  })

  it('passing the same contribution to project vs global stamps the right scope', () => {
    expect(resolveProjectTabs([notes]).find((t) => t.source === 'core')!.scope).toBe('project')
    expect(resolveGlobalTabs([notes]).find((t) => t.source === 'core')!.scope).toBe('global')
  })
})
