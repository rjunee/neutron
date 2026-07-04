/**
 * @neutronai/app — TabDescriptor mirror-parity test (refactor G3).
 *
 * `tabs/registry.ts` is the engine-side single source of truth for the
 * `TabDescriptor` wire shape (+ its `TabScope`/`TabSource`/`TabMountKind`
 * component types). BOTH clients re-declare the shape by hand instead of
 * importing across the workspace boundary (see the docstrings on each
 * mirror file):
 *   - `app/lib/tabs-client.ts` (Expo/mobile)
 *   - `landing/chat-react/tabs-client.ts` (web)
 *
 * This is a comment-only mirror — nothing enforces the three declarations
 * stay in lockstep. This test pins today's agreement two ways:
 *   1. Bidirectional structural-equivalence assignment (the same trick used
 *      by `app/__tests__/ws-envelope-parity.test.ts` and
 *      `runtime/__tests__/doc-links-parity.test.ts`): a value typed as one
 *      side's `TabDescriptor` is assigned to the other side's type and back.
 *      `tsc --noEmit` (part of the verify gate) fails at compile time the
 *      moment any field is added/renamed/retyped on just one side.
 *   2. REAL engine output (`resolveProjectTabs()` / `resolveGlobalTabs()`
 *      from `tabs/registry.ts` — pure, dependency-free, safe to import
 *      directly from this workspace) is round-tripped through both mirrors
 *      and asserted field-for-field identical, so the test also catches
 *      runtime-shape drift the type-only trick can miss (e.g. an optional
 *      field silently dropped by a lossy re-serialisation).
 *
 * Today all three declarations agree — this test characterizes that
 * agreement, not a fix. P8 later deletes the two hand mirrors against this
 * test (they'll import `tabs/registry.ts` types directly).
 */

import { describe, expect, test } from 'bun:test'

import {
  resolveGlobalTabs,
  resolveProjectTabs,
  type TabDescriptor as EngineTabDescriptor,
  type TabMountKind as EngineTabMountKind,
  type TabScope as EngineTabScope,
  type TabSource as EngineTabSource,
} from '../../tabs/registry'

import type {
  TabDescriptor as AppTabDescriptor,
  TabMountKind as AppTabMountKind,
  TabScope as AppTabScope,
  TabSource as AppTabSource,
} from '../lib/tabs-client'

import type {
  TabDescriptor as WebTabDescriptor,
  TabMountKind as WebTabMountKind,
  TabScope as WebTabScope,
  TabSource as WebTabSource,
} from '../../landing/chat-react/tabs-client'

describe('TabDescriptor — engine ↔ app/lib/tabs-client mirror', () => {
  test('bidirectional structural assignment compiles + round-trips at runtime', () => {
    const engine: EngineTabDescriptor = {
      key: 'chat',
      label: 'Chat',
      scope: 'project',
      source: 'builtin',
      order: 0,
      mount: { kind: 'builtin', target: 'chat' },
    }
    const asApp: AppTabDescriptor = engine
    const backToEngine: EngineTabDescriptor = asApp
    expect(backToEngine).toEqual(engine)
  })

  test('optional core_slug survives the round-trip (only present when source==="core")', () => {
    const engine: EngineTabDescriptor = {
      key: 'core:widgets',
      label: 'Widgets',
      scope: 'project',
      source: 'core',
      core_slug: 'widgets',
      order: 100,
      mount: { kind: 'webview', target: 'https://example.test/widgets' },
    }
    const asApp: AppTabDescriptor = engine
    expect(asApp.core_slug).toBe('widgets')
    const back: EngineTabDescriptor = asApp
    expect(back).toEqual(engine)
  })

  test('every real resolveProjectTabs()/resolveGlobalTabs() descriptor is a valid AppTabDescriptor', () => {
    const project = resolveProjectTabs()
    const global = resolveGlobalTabs()
    expect(project.length).toBeGreaterThan(0)
    expect(global.length).toBeGreaterThan(0)
    for (const d of [...project, ...global]) {
      const asApp: AppTabDescriptor = d
      const back: EngineTabDescriptor = asApp
      expect(back).toEqual(d)
    }
  })
})

describe('TabDescriptor — engine ↔ landing/chat-react/tabs-client mirror', () => {
  test('bidirectional structural assignment compiles + round-trips at runtime', () => {
    const engine: EngineTabDescriptor = {
      key: 'work_board',
      label: 'Work',
      scope: 'project',
      source: 'builtin',
      order: 5,
      mount: { kind: 'builtin', target: 'workboard' },
    }
    const asWeb: WebTabDescriptor = engine
    const backToEngine: EngineTabDescriptor = asWeb
    expect(backToEngine).toEqual(engine)
  })

  test('every real resolveProjectTabs()/resolveGlobalTabs() descriptor is a valid WebTabDescriptor', () => {
    const project = resolveProjectTabs()
    const global = resolveGlobalTabs()
    for (const d of [...project, ...global]) {
      const asWeb: WebTabDescriptor = d
      const back: EngineTabDescriptor = asWeb
      expect(back).toEqual(d)
    }
  })
})

describe('TabDescriptor — app ↔ web three-way transitivity', () => {
  test('an AppTabDescriptor value is also a valid WebTabDescriptor and vice versa', () => {
    const app: AppTabDescriptor = {
      key: 'documents',
      label: 'Documents',
      scope: 'project',
      source: 'builtin',
      order: 10,
      mount: { kind: 'builtin', target: 'docs' },
    }
    const asWeb: WebTabDescriptor = app
    const backToApp: AppTabDescriptor = asWeb
    expect(backToApp).toEqual(app)
  })
})

describe('component union literals agree across all three declarations', () => {
  test('TabScope: project | global', () => {
    const values: readonly EngineTabScope[] = ['project', 'global']
    for (const v of values) {
      const asApp: AppTabScope = v
      const asWeb: WebTabScope = v
      const backFromApp: EngineTabScope = asApp
      const backFromWeb: EngineTabScope = asWeb
      expect(backFromApp).toBe(v)
      expect(backFromWeb).toBe(v)
    }
  })

  test('TabSource: builtin | core | custom', () => {
    const values: readonly EngineTabSource[] = ['builtin', 'core', 'custom']
    for (const v of values) {
      const asApp: AppTabSource = v
      const asWeb: WebTabSource = v
      const backFromApp: EngineTabSource = asApp
      const backFromWeb: EngineTabSource = asWeb
      expect(backFromApp).toBe(v)
      expect(backFromWeb).toBe(v)
    }
  })

  test('TabMountKind: builtin | webview', () => {
    const values: readonly EngineTabMountKind[] = ['builtin', 'webview']
    for (const v of values) {
      const asApp: AppTabMountKind = v
      const asWeb: WebTabMountKind = v
      const backFromApp: EngineTabMountKind = asApp
      const backFromWeb: EngineTabMountKind = asWeb
      expect(backFromApp).toBe(v)
      expect(backFromWeb).toBe(v)
    }
  })
})
