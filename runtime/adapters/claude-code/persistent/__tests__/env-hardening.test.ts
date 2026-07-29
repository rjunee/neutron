/**
 * A spawned Claude child must never inherit interpreter-injection env vars.
 *
 * THE HOLE (adversarial security review 2026-07-20): `mergeEnv` starts from the
 * gateway's whole `process.env` and previously deleted ONLY what a composer
 * overlay explicitly unset (the three Anthropic auth vars, ISSUES #49).
 * `NODE_OPTIONS`, `LD_PRELOAD` and `DYLD_INSERT_LIBRARIES` were named NOWHERE in
 * that file, so a gateway environment carrying `NODE_OPTIONS=--require evil.js`
 * meant arbitrary code execution inside EVERY spawned child.
 *
 * Pinned here rather than in a composer overlay because the guarantee must hold
 * for every caller — a new substrate factory must not be able to forget it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mergeEnv } from '../repl-session.ts'

const INJECTORS = [
  'NODE_OPTIONS',
  'BUN_INSPECT',
  'LD_PRELOAD',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
] as const

const saved: Record<string, string | undefined> = {}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
    delete saved[k]
  }
})

function poison(k: string, v: string): void {
  saved[k] = process.env[k]
  process.env[k] = v
}

describe('mergeEnv — interpreter injection', () => {
  test('strips every injection var even with NO overlay', () => {
    for (const k of INJECTORS) poison(k, '/tmp/evil.js')
    const env = mergeEnv(undefined)
    for (const k of INJECTORS) expect(env[k]).toBeUndefined()
  })

  test('strips them even when an overlay is present (the overlay is not the guard)', () => {
    poison('NODE_OPTIONS', '--require /tmp/evil.js')
    poison('DYLD_INSERT_LIBRARIES', '/tmp/evil.dylib')
    const env = mergeEnv({ ANTHROPIC_API_KEY: undefined, SOME_VAR: 'x' })
    expect(env['NODE_OPTIONS']).toBeUndefined()
    expect(env['DYLD_INSERT_LIBRARIES']).toBeUndefined()
    expect(env['SOME_VAR']).toBe('x')
  })

  test('still honours the ISSUES #49 credential-scrub contract', () => {
    poison('ANTHROPIC_API_KEY', 'sk-host-leaked')
    const env = mergeEnv({ ANTHROPIC_API_KEY: undefined })
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  test('does not strip vars the child legitimately needs', () => {
    const env = mergeEnv(undefined)
    expect(env['PATH']).toBeDefined()
  })
})
