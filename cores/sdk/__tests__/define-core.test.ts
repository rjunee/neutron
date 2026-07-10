/**
 * X2 — `defineCore()` unit contract (the typed Core module factory).
 *
 * Behavioral coverage for the factory + its `isCoreModule` guard in
 * isolation from the install composer. The end-to-end proof that all 9
 * bundled Cores satisfy the contract (and that an under-implementing Core
 * hard-fails install) lives in
 * `cores/runtime/__tests__/define-core-conformance.test.ts` +
 * `gateway/__tests__/cores-under-implementation-hardfail.test.ts`. The
 * structural-mirror check that keeps `ToolCallContext` field-identical to the
 * registry's lives in the gateway test (the only band that may import both).
 */

import { describe, expect, test } from 'bun:test'

import { defineCore, isCoreModule } from '../define-core.ts'

interface FooDeps {
  backend: { do: () => Promise<string> }
}
interface FooBuilt {
  foo_do: (input: { n: number }) => Promise<{ ok: true }>
}

function buildFooTools(deps: FooDeps): FooBuilt {
  return { foo_do: async () => ({ ok: true as const, _: deps }) }
}

describe('defineCore()', () => {
  test('returns a branded CoreModule the guard recognises', () => {
    const core = defineCore({
      slug: 'foo_core',
      backendKey: 'backend',
      toolNames: ['foo_do'],
      buildTools: buildFooTools,
    })
    expect(core.__neutronCore).toBe(true)
    expect(core.slug).toBe('foo_core')
    expect(core.backendKey).toBe('backend')
    expect(core.toolNames).toEqual(['foo_do'])
    expect(typeof core.buildTools).toBe('function')
    expect(core.buildExtraTools).toBeUndefined()
    expect(isCoreModule(core)).toBe(true)
  })

  test('copies toolNames (caller mutation cannot corrupt the contract)', () => {
    const names = ['foo_do']
    const core = defineCore({
      slug: 'foo_core',
      backendKey: 'backend',
      toolNames: names,
      buildTools: buildFooTools,
    })
    names.push('mutated')
    expect(core.toolNames).toEqual(['foo_do'])
  })

  test('carries buildExtraTools when supplied', () => {
    const core = defineCore({
      slug: 'foo_core',
      backendKey: 'backend',
      toolNames: ['foo_do', 'foo_extra'],
      buildTools: buildFooTools,
      buildExtraTools: (_deps: { extra: unknown }) => ({
        foo_extra: async () => ({ ok: true }),
      }),
    })
    expect(typeof core.buildExtraTools).toBe('function')
    expect(isCoreModule(core)).toBe(true)
  })

  test('rejects a malformed contract at construction', () => {
    const base = {
      slug: 'foo_core',
      backendKey: 'backend',
      toolNames: ['foo_do'],
      buildTools: buildFooTools,
    }
    expect(() => defineCore({ ...base, slug: '' })).toThrow(/slug/)
    expect(() => defineCore({ ...base, backendKey: '' })).toThrow(/backendKey/)
    expect(() => defineCore({ ...base, toolNames: [] })).toThrow(/toolNames/)
    expect(() =>
      // @ts-expect-error — buildTools must be a function
      defineCore({ ...base, buildTools: null }),
    ).toThrow(/buildTools/)
  })
})

describe('isCoreModule()', () => {
  test('rejects non-modules', () => {
    expect(isCoreModule(null)).toBe(false)
    expect(isCoreModule(undefined)).toBe(false)
    expect(isCoreModule({})).toBe(false)
    expect(isCoreModule('nope')).toBe(false)
    expect(isCoreModule({ slug: 'x', backendKey: 'b', toolNames: [], buildTools: () => ({}) })).toBe(
      false,
    ) // missing brand
    expect(
      isCoreModule({ __neutronCore: true, slug: 'x', backendKey: 'b', toolNames: [] }),
    ).toBe(false) // missing buildTools
    expect(
      isCoreModule({
        __neutronCore: true,
        slug: '',
        backendKey: 'b',
        toolNames: [],
        buildTools: () => ({}),
      }),
    ).toBe(false) // empty slug
  })
})
