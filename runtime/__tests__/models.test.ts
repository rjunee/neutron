import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

/**
 * The exports are read once at module import via `process.env`. To exercise
 * the env-override path we set the env BEFORE the import and use the
 * dynamic-import / module-cache reset pattern.
 */

const ORIGINAL_BEST = process.env['NEUTRON_BEST_MODEL']
const ORIGINAL_FAST = process.env['NEUTRON_FAST_MODEL']

beforeEach(() => {
  delete process.env['NEUTRON_BEST_MODEL']
  delete process.env['NEUTRON_FAST_MODEL']
})

afterEach(() => {
  if (ORIGINAL_BEST !== undefined) process.env['NEUTRON_BEST_MODEL'] = ORIGINAL_BEST
  else delete process.env['NEUTRON_BEST_MODEL']
  if (ORIGINAL_FAST !== undefined) process.env['NEUTRON_FAST_MODEL'] = ORIGINAL_FAST
  else delete process.env['NEUTRON_FAST_MODEL']
})

async function freshImport(): Promise<typeof import('../models.ts')> {
  // Append a unique query-string so Bun bypasses the import cache and
  // re-evaluates the module against the current process.env.
  const cacheBust = `?t=${Date.now()}-${Math.random()}`
  const mod = (await import(`../models.ts${cacheBust}`)) as typeof import('../models.ts')
  return mod
}

describe('runtime/models', () => {
  test('BEST_MODEL defaults to Claude Opus 4.7 when env is unset', async () => {
    const { BEST_MODEL } = await freshImport()
    expect(BEST_MODEL).toBe('claude-opus-4-7')
  })

  test('FAST_MODEL defaults to Claude Haiku 4.5 when env is unset', async () => {
    const { FAST_MODEL } = await freshImport()
    expect(FAST_MODEL).toBe('claude-haiku-4-5-20251001')
  })

  test('PROBE_MODEL aliases FAST_MODEL', async () => {
    const { FAST_MODEL, PROBE_MODEL } = await freshImport()
    expect(PROBE_MODEL).toBe(FAST_MODEL)
  })

  test('NEUTRON_BEST_MODEL env override is honored', async () => {
    process.env['NEUTRON_BEST_MODEL'] = 'claude-opus-5-0-test'
    const { BEST_MODEL } = await freshImport()
    expect(BEST_MODEL).toBe('claude-opus-5-0-test')
  })

  test('NEUTRON_FAST_MODEL env override is honored and propagates to PROBE_MODEL', async () => {
    process.env['NEUTRON_FAST_MODEL'] = 'claude-haiku-5-0-test'
    const { FAST_MODEL, PROBE_MODEL } = await freshImport()
    expect(FAST_MODEL).toBe('claude-haiku-5-0-test')
    expect(PROBE_MODEL).toBe('claude-haiku-5-0-test')
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

  test('default model ids match documented Anthropic format', async () => {
    const { BEST_MODEL, FAST_MODEL } = await freshImport()
    // Anthropic model ids are kebab-cased, all lowercase, contain
    // 'claude-', and may include a date suffix.
    expect(BEST_MODEL).toMatch(/^claude-[a-z0-9-]+$/)
    expect(FAST_MODEL).toMatch(/^claude-[a-z0-9-]+$/)
  })
})
