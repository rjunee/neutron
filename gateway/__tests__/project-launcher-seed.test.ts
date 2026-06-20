/**
 * P3 cores wire-up — registry-derived launcher seed test.
 *
 * Asserts that:
 *   - `deriveLauncherSeedFromBundledCores(...)` filters to installed
 *     Cores in lexicographic slug order.
 *   - `InMemoryProjectLauncherStore` with a `seedProvider` evaluates
 *     the provider lazily — the seed is recomputed on each fresh
 *     (instance, project) lookup.
 *   - When the provider returns an empty array, the store falls back
 *     to the static `seed` (or `DEFAULT_LAUNCHER_SEED`).
 */

import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_LAUNCHER_SEED,
  InMemoryProjectLauncherStore,
  deriveLauncherSeedFromBundledCores,
  type LauncherEntry,
} from '../http/project-launcher-store.ts'
import type {
  CoresModuleState,
  LauncherIconMeta,
} from '../cores/composer-state.ts'
import type {
  BundledCore,
  BundledRegistry,
} from '../../cores/runtime/bundled-registry.ts'

function fakeBundledCore(slug: string, hasLauncherIcon = true): BundledCore {
  return {
    slug,
    package_name: `@neutronai/${slug}`,
    package_version: '0.1.0',
    coreDir: `/tmp/fake/${slug}`,
    rootDir: '/tmp/fake',
    source: 'bundled',
    manifest: {
      capabilities: [],
      tier_support: ['regular'],
      tools: [],
      ui_components: hasLauncherIcon
        ? [
            {
              name: `${slug}LauncherIcon`,
              entry_point: `./src/ui/launcher-icon.ts`,
              surface: 'launcher_icon',
            },
          ]
        : [],
      billing_hooks: [],
      linked_sources: [],
      secrets: [],
      compat: { coreApi: '^0.1.0' },
      build: { neutronVersion: '0.1.0' },
    } as unknown as BundledCore['manifest'],
  }
}

function fakeRegistry(cores: BundledCore[]): BundledRegistry {
  const map = new Map<string, BundledCore>()
  for (const c of cores) map.set(c.slug, c)
  return {
    list: () => [...cores],
    get: (slug) => map.get(slug) ?? null,
  }
}

function fakeCoresState(
  cores: BundledCore[],
  installedSlugs: string[],
  launcherIconsBySlug: Record<string, LauncherIconMeta> = {},
): CoresModuleState {
  const installed = new Map<string, never>()
  for (const slug of installedSlugs) installed.set(slug, {} as never)
  const launcherIcons = new Map<string, LauncherIconMeta>(
    Object.entries(launcherIconsBySlug),
  )
  return {
    registry: fakeRegistry(cores),
    installed,
    failures: [],
    launcherIcons,
  }
}

describe('deriveLauncherSeedFromBundledCores', () => {
  test('filters to installed slugs only', () => {
    const cores = [
      fakeBundledCore('notes'),
      fakeBundledCore('tasks_core'),
      fakeBundledCore('calendar_core'),
    ]
    const state = fakeCoresState(cores, ['notes', 'tasks_core']) // calendar_core fails to install
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed.map((s) => s.slug)).toEqual(['notes', 'tasks_core'])
  })

  test('uses well-known display names + emojis for known Tier 1 slugs', () => {
    const cores = [fakeBundledCore('reminders_core')]
    const state = fakeCoresState(cores, ['reminders_core'])
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed).toHaveLength(1)
    expect(seed[0]?.display_name).toBe('Reminders')
    expect(seed[0]?.launcher_icon).toEqual({ kind: 'emoji', value: '⏰' })
  })

  test('returns empty array when no Cores installed', () => {
    const state = fakeCoresState([fakeBundledCore('notes')], [])
    expect(deriveLauncherSeedFromBundledCores(state)).toEqual([])
  })

  test('manifest launcher_icon emoji wins over SLUG_DISPLAY_DEFAULTS', () => {
    // Regression for Argus R2 IMPORTANT #1, 2026-05-18: the prior
    // derivation hardcoded `defaults?.emoji` regardless of what the
    // Core's manifest declared. Result: email_managed's manifest 📬
    // was silently overridden by the defaults map's ✉️. Now the
    // pre-resolved manifest icon takes precedence.
    const cores = [fakeBundledCore('email_managed_core')]
    const state = fakeCoresState(
      cores,
      ['email_managed_core'],
      { email_managed_core: { emoji: '📬', label: 'Email' } },
    )
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed).toHaveLength(1)
    expect(seed[0]?.launcher_icon).toEqual({ kind: 'emoji', value: '📬' })
    expect(seed[0]?.display_name).toBe('Email')
  })

  test('a Core whose manifest icon differs from defaults: manifest wins', () => {
    // The defaults map says reminders_core → ⏰. A Core that manifest-
    // declares a different emoji must surface ITS emoji, not the
    // defaults map's. This is the fundamental contract the brief
    // demands: the manifest is the source of truth.
    const cores = [fakeBundledCore('reminders_core')]
    const state = fakeCoresState(
      cores,
      ['reminders_core'],
      { reminders_core: { emoji: '🔔', label: 'Bell' } }, // different from defaults '⏰'/'Reminders'
    )
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed[0]?.launcher_icon).toEqual({ kind: 'emoji', value: '🔔' })
    expect(seed[0]?.display_name).toBe('Bell')
  })

  test('falls back to SLUG_DISPLAY_DEFAULTS when launcher_icon is unresolved', () => {
    // A bundled Core whose launcher-icon.ts failed to load (or whose
    // manifest has no launcher_icon entry_point) gets the per-slug
    // defaults map. The defaults map remains the boot-warm fallback
    // for the known Tier 1 slugs.
    const cores = [fakeBundledCore('reminders_core')]
    const state = fakeCoresState(cores, ['reminders_core'])
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed[0]?.launcher_icon).toEqual({ kind: 'emoji', value: '⏰' })
    expect(seed[0]?.display_name).toBe('Reminders')
  })

  test('falls back to FALLBACK_EMOJI for an unknown slug with no manifest icon', () => {
    // A new bundled Core (or third-party Core) with a manifest
    // launcher_icon surface but no resolved icon AND no entry in the
    // defaults map renders the generic 🧩 + raw slug. Better than
    // breaking the launcher tile layout.
    const cores = [fakeBundledCore('exotic_core')]
    const state = fakeCoresState(cores, ['exotic_core'])
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed[0]?.launcher_icon).toEqual({ kind: 'emoji', value: '🧩' })
    expect(seed[0]?.display_name).toBe('exotic_core')
  })

  test('omits Cores without a launcher_icon manifest surface', () => {
    // A Core that doesn't ship a launcher_icon ui_components entry is
    // not surfaced on the launcher at all. Its tools still register —
    // it just doesn't have a tile.
    const cores = [
      fakeBundledCore('with_icon', true),
      fakeBundledCore('no_icon', false),
    ]
    const state = fakeCoresState(cores, ['with_icon', 'no_icon'])
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed.map((s) => s.slug)).toEqual(['with_icon'])
  })

  test('propagates long_press_menu + primary_action + app_tab_path (ISSUE #17)', () => {
    // Regression guard for ISSUE #17 — the launcher tiles for Tasks /
    // Reminders / Notes / Email-Managed / Code-Gen declare
    // `primary_action`, `app_tab_path`, and `long_press_menu` on their
    // `LAUNCHER_ICON` module. The pipeline must thread those fields
    // all the way from the LauncherIconMeta through the LauncherEntry
    // seed (and ultimately the HTTP body the app consumes).
    const cores = [fakeBundledCore('tasks_core')]
    const state = fakeCoresState(
      cores,
      ['tasks_core'],
      {
        tasks_core: {
          emoji: '✅',
          label: 'Tasks',
          primary_action: 'open_app_tab',
          app_tab_path: '/projects/<project_id>/tasks',
          long_press_menu: [
            {
              id: 'capture',
              label: 'Capture a task',
              action: 'chat_send_prefix',
              prefix: '/task ',
            },
            {
              id: 'browse',
              label: 'Open task list',
              action: 'open_app_tab',
            },
            {
              id: 'pick_next',
              label: 'What should I focus on?',
              action: 'chat_send',
              text: '/task focus',
            },
          ],
        },
      },
    )
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed).toHaveLength(1)
    expect(seed[0]?.primary_action).toBe('open_app_tab')
    expect(seed[0]?.app_tab_path).toBe('/projects/<project_id>/tasks')
    expect(seed[0]?.long_press_menu).toHaveLength(3)
    expect(seed[0]?.long_press_menu?.[0]).toEqual({
      id: 'capture',
      label: 'Capture a task',
      action: 'chat_send_prefix',
      prefix: '/task ',
    })
    expect(seed[0]?.long_press_menu?.[1]).toEqual({
      id: 'browse',
      label: 'Open task list',
      action: 'open_app_tab',
    })
    expect(seed[0]?.long_press_menu?.[2]).toEqual({
      id: 'pick_next',
      label: 'What should I focus on?',
      action: 'chat_send',
      text: '/task focus',
    })
  })

  test('legacy {emoji, label}-only Cores still install (ISSUE #17 forward-compat)', () => {
    // A Core whose LAUNCHER_ICON is the v0.1.0 shape with NO
    // primary_action / app_tab_path / long_press_menu must continue to
    // surface as a launcher tile — just without the richer fields.
    const cores = [fakeBundledCore('notes')]
    const state = fakeCoresState(
      cores,
      ['notes'],
      { notes: { emoji: '🧠', label: 'Notes' } },
    )
    const seed = deriveLauncherSeedFromBundledCores(state)
    expect(seed).toHaveLength(1)
    expect(seed[0]?.slug).toBe('notes')
    expect(seed[0]?.primary_action).toBeUndefined()
    expect(seed[0]?.app_tab_path).toBeUndefined()
    expect(seed[0]?.long_press_menu).toBeUndefined()
  })
})

describe('InMemoryProjectLauncherStore — dynamic seedProvider', () => {
  test('uses seedProvider on first (instance, project) lookup', async () => {
    let providerCalls = 0
    const dynamic: ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>> = [
      { slug: 'foo', display_name: 'Foo', launcher_icon: { kind: 'emoji', value: '🚀' } },
    ]
    const store = new InMemoryProjectLauncherStore({
      seedProvider: () => {
        providerCalls += 1
        return dynamic
      },
    })
    const entries = await store.list('t1', 'p1')
    expect(providerCalls).toBe(1)
    expect(entries.map((e) => e.slug)).toEqual(['foo'])
  })

  test('falls back to static DEFAULT_LAUNCHER_SEED when provider returns []', async () => {
    const store = new InMemoryProjectLauncherStore({
      seedProvider: () => [],
    })
    const entries = await store.list('t1', 'p1')
    expect(entries.map((e) => e.slug)).toEqual(
      DEFAULT_LAUNCHER_SEED.map((s) => s.slug),
    )
  })

  test('mutations after a dynamic seed are persisted per (instance, project)', async () => {
    const dynamic: ReadonlyArray<Omit<LauncherEntry, 'reorder_index'>> = [
      { slug: 'foo', display_name: 'Foo', launcher_icon: { kind: 'emoji', value: '🚀' } },
      { slug: 'bar', display_name: 'Bar', launcher_icon: { kind: 'emoji', value: '🎯' } },
    ]
    const store = new InMemoryProjectLauncherStore({
      seedProvider: () => dynamic,
    })
    await store.list('t1', 'p1') // seed
    const after = await store.uninstall('t1', 'p1', 'foo')
    expect(after.map((e) => e.slug)).toEqual(['bar'])
    // Different (instance, project) reads from the live provider again.
    const other = await store.list('t1', 'p2')
    expect(other.map((e) => e.slug)).toEqual(['foo', 'bar'])
  })
})
