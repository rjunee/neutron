import { describe, expect, test } from 'bun:test'
import { loadAgentSystemPrompt, PERSONA_AGENT_KINDS } from './agent-prompts.ts'

/**
 * Persona prompt disk-source VERIFY.
 *
 * HISTORY: this file used to also verify a Forge/Argus disk-source contract
 * (`prompts/forge.md` / `prompts/argus.md` via the deleted `loadForgeTemplate`
 * / `renderForgePrompt`). The v1 render path is gone — the live Forge/Argus
 * contract is inlined in `trident/inner-workflow.mjs` (asserted in
 * `vajra-fixes.test.ts`), and `prompts/forge.md` / `argus.md` are now NON-LIVE
 * reference only. What REMAINS live here is the persona (Atlas/Sentinel)
 * system-prompt loader, consumed by the `agent-dispatch/` dispatch service.
 */
describe('persona prompts resolve from disk BY TYPE', () => {
  test('atlas + sentinel load their persona from disk (source = file)', () => {
    for (const kind of PERSONA_AGENT_KINDS) {
      const got = loadAgentSystemPrompt(kind)
      expect(got.source).toBe('file')
      expect(got.content.trim().length).toBeGreaterThan(0)
    }
  })

  test('the persona roles are exactly {atlas, sentinel}', () => {
    expect([...PERSONA_AGENT_KINDS].sort()).toEqual(['atlas', 'sentinel'])
  })
})
