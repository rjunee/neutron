import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  normalizeProvider,
  selectSubstrateFactory,
  type Provider,
} from './select-substrate.ts'
import { createClaudeCodeSubstrateAuto } from './claude-code/index.ts'
import { createGptResponsesApiSubstrate } from './openai-responses/index.ts'
import { createCodexCliSubstrate } from './codex-cli/index.ts'

// HERMETIC: these tests assert substrate SELECTION and wiring, not spawning — but
// `start()` reaches the real `HerdrHost`, which now works. Pointing the socket at a
// path that does not exist makes the spawn fail immediately instead of creating REAL
// PANES on the developer's herdr server and waiting out the pid timeout. Before the
// transport was fixed these tests were fast by accident: the client could not get past
// its own protocol ping, so nothing was ever spawned.
//
// SAVED AND RESTORED, not written at module scope. `HERDR_SOCKET_PATH` is the switch
// that decides whether the LIVE herdr proofs can reach a server at all, and those are
// the only tests in this repo that can see the real one — a module-scope write with no
// teardown turns "make my own case hermetic" into "silently disable the instrument for
// everything that runs after me in this process". A test may not be able to disable the
// only thing capable of catching a whole defect class, and no coverage number would
// ever show it.
const PRIOR_HERDR_SOCKET = process.env['HERDR_SOCKET_PATH']
beforeAll(() => {
  process.env['HERDR_SOCKET_PATH'] = '/nonexistent/herdr-test-must-not-connect.sock'
})
afterAll(() => {
  if (PRIOR_HERDR_SOCKET === undefined) delete process.env['HERDR_SOCKET_PATH']
  else process.env['HERDR_SOCKET_PATH'] = PRIOR_HERDR_SOCKET
})

describe('select-substrate', () => {
  test("select('anthropic') returns the Claude Code factory VERBATIM (default backend, unchanged)", () => {
    const sel = selectSubstrateFactory('anthropic')
    expect(sel.provider).toBe('anthropic')
    // Byte-identical guarantee: the anthropic path resolves the SAME factory
    // reference every production construction site hardcodes today.
    expect(sel.create).toBe(createClaudeCodeSubstrateAuto)
  })

  test("select('openai') returns the GPT Responses API factory verbatim", () => {
    const sel = selectSubstrateFactory('openai')
    expect(sel.provider).toBe('openai')
    expect(sel.create).toBe(createGptResponsesApiSubstrate)
  })

  test("select('openai-codex-cli') returns the Codex CLI factory verbatim", () => {
    const sel = selectSubstrateFactory('openai-codex-cli')
    expect(sel.provider).toBe('openai-codex-cli')
    expect(sel.create).toBe(createCodexCliSubstrate)
  })

  test('default-when-absent/empty/whitespace is anthropic (byte-identical Claude case)', () => {
    expect(normalizeProvider(undefined)).toBe('anthropic')
    expect(normalizeProvider(null)).toBe('anthropic')
    expect(normalizeProvider('')).toBe('anthropic')
    expect(normalizeProvider('   ')).toBe('anthropic')
    expect(normalizeProvider('anthropic')).toBe('anthropic')
  })

  test('UNKNOWN non-empty provider THROWS a loud actionable error (never coerced to anthropic)', () => {
    // Root-cause fix: a typo must fail loud, not silently route data to Claude.
    expect(() => normalizeProvider('openaii')).toThrow(/Unknown model provider 'openaii'/)
    expect(() => normalizeProvider('gemini')).toThrow(/Valid values:/)
    expect(() => normalizeProvider('gpt-9')).toThrow(/Refusing to coerce/)
    // The error names the valid providers.
    expect(() => normalizeProvider('nonsense')).toThrow(/'anthropic'.*'openai'.*'openai-codex-cli'/)
  })

  test('normalizeProvider preserves the two known alternates (and trims)', () => {
    expect(normalizeProvider('openai')).toBe('openai')
    expect(normalizeProvider('openai-codex-cli')).toBe('openai-codex-cli')
    expect(normalizeProvider('  openai  ')).toBe('openai')
  })

  test('every Provider variant maps to a discriminated factory', () => {
    const providers: Provider[] = ['anthropic', 'openai', 'openai-codex-cli']
    for (const p of providers) {
      const sel = selectSubstrateFactory(p)
      expect(sel.provider).toBe(p)
      expect(typeof sel.create).toBe('function')
    }
  })
})
