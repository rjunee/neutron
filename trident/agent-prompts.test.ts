import { describe, expect, test } from 'bun:test'
import {
  AGENT_PROMPT_FALLBACK,
  DISPATCH_AGENT_KINDS,
  loadAgentSystemPrompt,
  type DispatchAgentKind,
} from './agent-prompts.ts'

/**
 * The lifted `prompts/<kind>.md` files were dead code before this module —
 * trident built every dispatched prompt inline. These tests pin that the
 * REAL on-disk execution contracts now load and reach the dispatch as the
 * agent's system prompt, and that a missing/broken file degrades to the
 * inline fallback rather than throwing into the dispatch path.
 */

/** A signature line unique to each agent's real `prompts/<kind>.md`. */
const SIGNATURE: Record<DispatchAgentKind, string> = {
  forge: 'You are Forge',
  argus: 'You are Argus',
  atlas: 'You are Atlas',
  sentinel: 'You are Sentinel',
}

describe('loadAgentSystemPrompt — real prompts/<kind>.md (the dead-code fix)', () => {
  for (const kind of DISPATCH_AGENT_KINDS) {
    test(`${kind}: loads the on-disk contract, not the inline fallback`, () => {
      const got = loadAgentSystemPrompt(kind)
      expect(got.kind).toBe(kind)
      expect(got.source).toBe('file')
      // The real file content reached us…
      expect(got.content).toContain(SIGNATURE[kind])
      // …and it is the rich contract, not the terse one-line fallback.
      expect(got.content.length).toBeGreaterThan(AGENT_PROMPT_FALLBACK[kind].length)
      expect(got.content).not.toBe(AGENT_PROMPT_FALLBACK[kind])
    })
  }

  test('forge.md is the detailed contract (delivery mechanics), not a stub', () => {
    const got = loadAgentSystemPrompt('forge')
    // A load-bearing line from the real forge.md execution contract.
    expect(got.content.toLowerCase()).toContain('contract')
  })

  test('argus.md carries the cross-model review contract', () => {
    const got = loadAgentSystemPrompt('argus')
    expect(got.content.toLowerCase()).toContain('cross-model')
  })

  test('template tokens are substituted away (no raw {{OWNER_HOME}} ships)', () => {
    for (const kind of DISPATCH_AGENT_KINDS) {
      const got = loadAgentSystemPrompt(kind)
      expect(got.content).not.toContain('{{OWNER_HOME}}')
    }
  })
})

describe('loadAgentSystemPrompt — substitution', () => {
  test('passes buildPromptVars-style vars through to the loader', () => {
    const seen: Array<{ name: string; vars: Readonly<Record<string, string>> }> = []
    const got = loadAgentSystemPrompt('atlas', {
      load_prompt: (name, vars) => {
        seen.push({ name, vars })
        return `RESOLVED ${vars.OWNER_HOME ?? ''}`
      },
      vars: { OWNER_HOME: '/home/owner', TELEGRAM_CHAT_ID: '123' },
    })
    expect(got.source).toBe('file')
    expect(got.content).toBe('RESOLVED /home/owner')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe('atlas.md')
    expect(seen[0]?.vars.OWNER_HOME).toBe('/home/owner')
  })
})

describe('loadAgentSystemPrompt — fallback never throws into dispatch', () => {
  test('a thrown read error falls back to the inline identity', () => {
    for (const kind of DISPATCH_AGENT_KINDS) {
      const got = loadAgentSystemPrompt(kind, {
        load_prompt: () => {
          throw new Error('ENOENT: prompts dir missing')
        },
      })
      expect(got.source).toBe('fallback')
      expect(got.content).toBe(AGENT_PROMPT_FALLBACK[kind])
      expect(got.content.length).toBeGreaterThan(0)
    }
  })

  test('an empty/whitespace file falls back (never dispatch a blank prompt)', () => {
    const got = loadAgentSystemPrompt('sentinel', { load_prompt: () => '   \n  ' })
    expect(got.source).toBe('fallback')
    expect(got.content).toBe(AGENT_PROMPT_FALLBACK.sentinel)
  })

  test('every kind has a non-empty inline fallback', () => {
    for (const kind of DISPATCH_AGENT_KINDS) {
      expect(AGENT_PROMPT_FALLBACK[kind].trim().length).toBeGreaterThan(0)
    }
  })
})
