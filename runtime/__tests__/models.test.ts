import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

/**
 * The exports are read once at module import via `process.env`. To exercise
 * the env-override path we set the env BEFORE the import and use the
 * dynamic-import / module-cache reset pattern.
 */

const ORIGINAL_BEST = process.env['NEUTRON_BEST_MODEL']
const ORIGINAL_FAST = process.env['NEUTRON_FAST_MODEL']
const ORIGINAL_PROBE = process.env['NEUTRON_PROBE_MODEL']

beforeEach(() => {
  delete process.env['NEUTRON_BEST_MODEL']
  delete process.env['NEUTRON_FAST_MODEL']
  delete process.env['NEUTRON_PROBE_MODEL']
})

afterEach(() => {
  if (ORIGINAL_BEST !== undefined) process.env['NEUTRON_BEST_MODEL'] = ORIGINAL_BEST
  else delete process.env['NEUTRON_BEST_MODEL']
  if (ORIGINAL_FAST !== undefined) process.env['NEUTRON_FAST_MODEL'] = ORIGINAL_FAST
  else delete process.env['NEUTRON_FAST_MODEL']
  if (ORIGINAL_PROBE !== undefined) process.env['NEUTRON_PROBE_MODEL'] = ORIGINAL_PROBE
  else delete process.env['NEUTRON_PROBE_MODEL']
})

async function freshImport(): Promise<typeof import('../models.ts')> {
  // Append a unique query-string so Bun bypasses the import cache and
  // re-evaluates the module against the current process.env.
  const cacheBust = `?t=${Date.now()}-${Math.random()}`
  const mod = (await import(`../models.ts${cacheBust}`)) as typeof import('../models.ts')
  return mod
}

describe('runtime/models', () => {
  test('defaults pin model classes rather than versioned model ids', async () => {
    const { BEST_MODEL, FABLE_MODEL, SONNET_MODEL, FAST_MODEL } = await freshImport()
    expect({ BEST_MODEL, FABLE_MODEL, SONNET_MODEL, FAST_MODEL }).toEqual({
      BEST_MODEL: 'opus',
      FABLE_MODEL: 'fable',
      SONNET_MODEL: 'sonnet',
      FAST_MODEL: 'haiku',
    })
  })

  // REWRITTEN 2026-09-15. This test used to assert `PROBE_MODEL === FAST_MODEL`,
  // and that alias is what silently removed the owner's usage meter: `FAST_MODEL`
  // is the CLI alias `'haiku'`, which a spawned `claude` resolves but a raw
  // `POST /v1/messages` answers with `404 not_found_error: model: haiku`. A 404
  // carries no `anthropic-ratelimit-unified-*` headers, so the usage probe read
  // no windows and every surface drew its "unknown" divider.
  test('PROBE_MODEL is addressable by the raw API and does NOT alias FAST_MODEL', async () => {
    const { FAST_MODEL, PROBE_MODEL } = await freshImport()
    expect(PROBE_MODEL).not.toBe(FAST_MODEL)
    expect(PROBE_MODEL).toMatch(/^claude-[a-z0-9.-]+-\d{8}$/)
  })

  test('NEUTRON_BEST_MODEL env override is honored', async () => {
    process.env['NEUTRON_BEST_MODEL'] = 'claude-opus-5-0-test'
    const { BEST_MODEL } = await freshImport()
    expect(BEST_MODEL).toBe('claude-opus-5-0-test')
  })

  test('NEUTRON_FAST_MODEL is honored and no longer drags PROBE_MODEL with it', async () => {
    process.env['NEUTRON_FAST_MODEL'] = 'claude-haiku-5-0-test'
    const { FAST_MODEL, PROBE_MODEL } = await freshImport()
    expect(FAST_MODEL).toBe('claude-haiku-5-0-test')
    // The decoupling: overriding the CLI model must not silently repoint the raw
    // API probe at something the Messages endpoint may not address.
    expect(PROBE_MODEL).not.toBe('claude-haiku-5-0-test')
  })

  test('NEUTRON_PROBE_MODEL overrides the probe model on its own', async () => {
    process.env['NEUTRON_PROBE_MODEL'] = 'claude-haiku-9-9-20990101'
    const { FAST_MODEL, PROBE_MODEL } = await freshImport()
    expect(PROBE_MODEL).toBe('claude-haiku-9-9-20990101')
    expect(FAST_MODEL).toBe('haiku')
  })

  test('exports are non-empty strings', async () => {
    const { BEST_MODEL, FAST_MODEL, PROBE_MODEL } = await freshImport()
    expect(typeof BEST_MODEL).toBe('string')
    expect(typeof FAST_MODEL).toBe('string')
    expect(typeof PROBE_MODEL).toBe('string')
    expect(BEST_MODEL.length).toBeGreaterThan(0)
    expect(FAST_MODEL.length).toBeGreaterThan(0)
    expect(PROBE_MODEL.length).toBeGreaterThan(0)
  })

  test('default model classes contain no version segment', async () => {
    const { BEST_MODEL, FABLE_MODEL, SONNET_MODEL, FAST_MODEL } = await freshImport()
    for (const model of [BEST_MODEL, FABLE_MODEL, SONNET_MODEL, FAST_MODEL]) {
      expect(model).toMatch(/^[a-z]+$/)
      expect(model).not.toMatch(/\d/)
    }
  })
})
