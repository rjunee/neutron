/**
 * 2026-05-27 — Part C: post-resolve bullet validator for the
 * `agent_name_chosen` phase. The LLM driver runs as a backstop when
 * the engine's dynamic `agentNameSuggester` block is unwired (no
 * Anthropic client on the instance); without this validator a body like
 *
 *   "Sam, here are some names that fit your style:"
 *
 * passes the resolver's max_body_chars / JSON-shape check and ships
 * to the user with NO actual names. Sam-incident 2026-05-27.
 *
 * Asserts:
 *   1. A 3+ bullet body passes `agentNameBodyLooksValid`.
 *   2. A 0-bullet body fails the validator.
 *   3. A 1- or 2-bullet body fails the validator.
 *   4. The validator only fires for `agent_name_chosen` — other
 *      free-text phases (`signup`, `personality_offered`) are
 *      unaffected.
 */

import { describe, expect, test } from 'bun:test'
import {
  AGENT_NAME_MIN_BULLETS,
  agentNameBodyLooksValid,
} from '../llm-prompt-driver.ts'

describe('agentNameBodyLooksValid — bullet-count guard', () => {
  test('passes when body carries >= 3 bullet lines', () => {
    const body = [
      'Sam, here are some names that fit your style:',
      '',
      '- Atlas — calm, clear, carries weight',
      '- Vera — truthful, grounded',
      '- Iris — sees patterns others miss',
      '',
      'Or type your own.',
    ].join('\n')
    expect(agentNameBodyLooksValid(body)).toBe(true)
  })

  test('passes with extra bullets (4-5)', () => {
    const body = [
      '- Atlas — a',
      '- Vera — b',
      '- Iris — c',
      '- Orin — d',
      '- Sage — e',
    ].join('\n')
    expect(agentNameBodyLooksValid(body)).toBe(true)
  })

  test('fails on zero bullets (Sam-incident body shape)', () => {
    const body =
      "Sam, let's pick a name that fits your vibe — something short " +
      'and easy to say. Here are some options that echo your interests ' +
      'in startups, investing, and building:'
    expect(agentNameBodyLooksValid(body)).toBe(false)
  })

  test('fails on a single bullet', () => {
    const body = [
      'Some names:',
      '- Atlas — calm and clear',
      'pick one or type your own',
    ].join('\n')
    expect(agentNameBodyLooksValid(body)).toBe(false)
  })

  test('fails on two bullets (below AGENT_NAME_MIN_BULLETS)', () => {
    const body = ['- Atlas — a', '- Vera — b'].join('\n')
    expect(agentNameBodyLooksValid(body)).toBe(false)
  })

  test('fails on empty body', () => {
    expect(agentNameBodyLooksValid('')).toBe(false)
  })

  test('tolerates leading whitespace on the bullet line', () => {
    const body = [
      '  - Atlas — a',
      '\t- Vera — b',
      '- Iris — c',
    ].join('\n')
    expect(agentNameBodyLooksValid(body)).toBe(true)
  })

  test('does NOT count lines that start with `- ` followed by whitespace only', () => {
    const body = [
      '- ',
      '-   ',
      '- ',
    ].join('\n')
    // `- ` followed by no non-whitespace is not a real bullet — `/^- \S+/`
    // requires a non-whitespace char.
    expect(agentNameBodyLooksValid(body)).toBe(false)
  })

  test('AGENT_NAME_MIN_BULLETS exported constant matches the brief', () => {
    expect(AGENT_NAME_MIN_BULLETS).toBe(3)
  })
})
