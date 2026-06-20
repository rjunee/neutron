/**
 * @neutronai/runtime — router thinking-budget control tests.
 *
 * Pins the root-cause fix (2026-06-05): the router classifier spawn must carry
 * `MAX_THINKING_TOKENS=0` by default so it never burns 20-40s on extended
 * thinking, with a `NEUTRON_ROUTER_MAX_THINKING_TOKENS` env escape hatch.
 */

import { describe, expect, test } from 'bun:test'

import {
  ROUTER_MAX_THINKING_TOKENS_DEFAULT,
  ROUTER_MAX_THINKING_TOKENS_ENV,
  resolveRouterThinkingBudget,
  routerThinkingEnvOverlay,
} from '../router-thinking-budget.ts'

describe('resolveRouterThinkingBudget', () => {
  test('defaults to 0 (thinking disabled) when env is unset', () => {
    expect(resolveRouterThinkingBudget({})).toBe('0')
    expect(ROUTER_MAX_THINKING_TOKENS_DEFAULT).toBe('0')
  })

  test('defaults to 0 on empty / whitespace env', () => {
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '' })).toBe('0')
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '   ' })).toBe('0')
  })

  test('honours a non-negative integer override', () => {
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '0' })).toBe('0')
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '2048' })).toBe('2048')
  })

  test('falls back to default on malformed / negative / non-integer override', () => {
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '-5' })).toBe('0')
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '1.5' })).toBe('0')
    expect(resolveRouterThinkingBudget({ [ROUTER_MAX_THINKING_TOKENS_ENV]: 'abc' })).toBe('0')
  })
})

describe('routerThinkingEnvOverlay', () => {
  test('returns a single MAX_THINKING_TOKENS entry', () => {
    expect(routerThinkingEnvOverlay({})).toEqual({ MAX_THINKING_TOKENS: '0' })
    expect(routerThinkingEnvOverlay({ [ROUTER_MAX_THINKING_TOKENS_ENV]: '512' })).toEqual({
      MAX_THINKING_TOKENS: '512',
    })
  })
})
