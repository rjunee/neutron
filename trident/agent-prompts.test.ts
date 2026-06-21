import { describe, expect, test } from 'bun:test'
import {
  AGENT_PROMPT_FALLBACK,
  PERSONA_AGENT_KINDS,
  loadAgentSystemPrompt,
  type PersonaAgentKind,
} from './agent-prompts.ts'

/**
 * The lifted `prompts/{atlas,sentinel}.md` persona files were dead code
 * before this module — trident built every dispatched prompt inline. These
 * tests pin that the REAL on-disk personas now load and reach the dispatch
 * as the agent's system prompt, and that a missing/broken file degrades to
 * the inline fallback rather than throwing into the dispatch path.
 *
 * Disk loading is scoped to the persona agents (Atlas / Sentinel) ONLY —
 * Forge/Argus keep their native `trident/prompts.ts` contract and are not a
 * `PersonaAgentKind`, so `loadAgentSystemPrompt('forge')` is a compile error
 * (the regression guard lives in the type, see orchestrator-native-prompt.test.ts).
 */

/** A signature line unique to each persona's real `prompts/<kind>.md`. */
const SIGNATURE: Record<PersonaAgentKind, string> = {
  atlas: 'You are Atlas',
  sentinel: 'You are Sentinel',
}

describe('loadAgentSystemPrompt — real prompts/<kind>.md (the dead-code fix)', () => {
  for (const kind of PERSONA_AGENT_KINDS) {
    test(`${kind}: loads the on-disk persona, not the inline fallback`, () => {
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

  test('persona loading is scoped to atlas/sentinel — forge/argus are not persona kinds', () => {
    // The only dispatchable disk-prompt kinds are the persona agents. Forge
    // and Argus deliberately have NO entry here; their contract is native.
    expect([...PERSONA_AGENT_KINDS].sort()).toEqual(['atlas', 'sentinel'])
    expect(PERSONA_AGENT_KINDS).not.toContain('forge' as never)
    expect(PERSONA_AGENT_KINDS).not.toContain('argus' as never)
    expect(Object.keys(AGENT_PROMPT_FALLBACK).sort()).toEqual(['atlas', 'sentinel'])
  })

  test('template tokens are substituted away (no raw {{OWNER_HOME}} ships)', () => {
    for (const kind of PERSONA_AGENT_KINDS) {
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
    for (const kind of PERSONA_AGENT_KINDS) {
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

  test('every persona kind has a non-empty inline fallback', () => {
    for (const kind of PERSONA_AGENT_KINDS) {
      expect(AGENT_PROMPT_FALLBACK[kind].trim().length).toBeGreaterThan(0)
    }
  })
})
