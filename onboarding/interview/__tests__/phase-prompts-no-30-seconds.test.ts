/**
 * v0.1.78 (2026-05-22) — phase-prompts snapshot pin.
 *
 * Sam-decisions 2026-05-22: the import_running bodies must NOT contain
 * the arbitrary "30 seconds" duration estimate, and must NOT contain a
 * "$X of $Y" dollar-cost framing (Max-OAuth owners don't pay marginal
 * cost; the budget-cap subsystem was killed).
 *
 * The pin exercises buildImportRunningPromptSpec across every sub_step
 * + every flag combination AND grep-checks the bodies for the forbidden
 * substrings. A regression that re-introduces either string will fail
 * this test immediately at TS time, not at runtime when a user sees it.
 */

import { expect, test } from 'bun:test'
import { buildImportRunningPromptSpec } from '../phase-prompts.ts'

const FORBIDDEN = [
  // The brief's two named anti-patterns.
  /30\s*seconds?/i,
  /usual\s*30/i,
  // Any "$X of $Y" cost framing.
  /\$\s*\d+(\.\d+)?\s*of\s*\$\s*\d+/i,
]

const SAMPLE_BODIES: string[] = []

for (const sub_step of ['status', 'rate_limit_paused', 'failed', 'completed'] as const) {
  for (const source of ['chatgpt-zip', 'claude-zip', null] as const) {
    for (const flagSet of [
      {},
      { is_long_running: true },
      { is_rate_limit_cooling_off: true },
      { is_long_running: true, is_rate_limit_cooling_off: true },
    ] as const) {
      for (const counts of [
        {},
        { pass1_chunks_done: 0, pass1_chunks_total: 0 },
        { pass1_chunks_done: 3, pass1_chunks_total: 5 },
      ] as const) {
        const spec = buildImportRunningPromptSpec({
          sub_step,
          source,
          failure_reason: 'synthetic failure for snapshot',
          ...flagSet,
          ...counts,
        })
        SAMPLE_BODIES.push(spec.body)
      }
    }
  }
}

test('no import_running body mentions "30 seconds" or "$X of $Y"', () => {
  for (const body of SAMPLE_BODIES) {
    for (const pattern of FORBIDDEN) {
      if (pattern.test(body)) {
        throw new Error(
          `forbidden pattern ${pattern} matched in import_running body:\n  ${body}`,
        )
      }
    }
  }
  // Sanity: we actually exercised some bodies (the matrix above produces
  // dozens of variants; a regression that drops the entire builder
  // shouldn't pass vacuously).
  expect(SAMPLE_BODIES.length).toBeGreaterThan(20)
})

test('rate_limit_paused body surfaces the auto-resume framing', () => {
  // Argus r1 fix (PR #271, 2026-05-22) — the prior "still waiting on
  // Claude's rate limit" body was a lie: nothing checked again after
  // the runner gave up. The fix wires the engine's import-running cron
  // to auto-resume from paused after COOLDOWN_AFTER_PAUSED_MS, so the
  // body now truthfully says "I'll auto-resume in a few minutes".
  const spec = buildImportRunningPromptSpec({
    sub_step: 'rate_limit_paused',
    source: 'chatgpt-zip',
    pass1_chunks_done: 4,
    pass1_chunks_total: 10,
  })
  expect(spec.body.toLowerCase()).toContain('auto-resume')
  expect(spec.body.toLowerCase()).toContain('rate limit')
  // No buttons — the brief says no skip prompt; the user waits.
  expect(spec.options.length).toBe(0)
  expect(spec.allow_freeform).toBe(true)
})

test('status with is_rate_limit_cooling_off surfaces the cooling-off framing', () => {
  const spec = buildImportRunningPromptSpec({
    sub_step: 'status',
    source: 'claude-zip',
    is_rate_limit_cooling_off: true,
  })
  expect(spec.body.toLowerCase()).toContain('rate limit')
  expect(spec.body.toLowerCase()).toContain('cooling')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2026-05-26 (Sam-specced) — the v0.1.85 Max-OAuth "chunking smaller" one-time
// notice was an infrastructure leak ("Running on Max subscription — chunking
// smaller (slower but stays under Anthropic's per-call cap)") and was removed.
// These tests pin the body so it stays gone, while confirming the
// cooling-off / long-running branches still surface their legitimate framing.
// ─────────────────────────────────────────────────────────────────────────────

test('2026-05-26 — using_max_oauth_chunking + status + 0 chunks done → notice NOT attached', () => {
  const spec = buildImportRunningPromptSpec({
    sub_step: 'status',
    source: 'claude-zip',
    pass1_chunks_done: 0,
    using_max_oauth_chunking: true,
  })
  expect(spec.body.toLowerCase()).not.toContain('max subscription')
  expect(spec.body.toLowerCase()).not.toContain('per-call cap')
  expect(spec.body.toLowerCase()).not.toContain('chunking smaller')
})

test('2026-05-26 — using_max_oauth_chunking + some chunks done → notice still NOT attached', () => {
  const spec = buildImportRunningPromptSpec({
    sub_step: 'status',
    source: 'claude-zip',
    pass1_chunks_done: 17,
    pass1_chunks_total: 200,
    using_max_oauth_chunking: true,
  })
  expect(spec.body.toLowerCase()).not.toContain('max subscription')
  expect(spec.body.toLowerCase()).not.toContain('per-call cap')
})

test('2026-05-26 — without using_max_oauth_chunking → notice never attached (BYO API key owners)', () => {
  const spec = buildImportRunningPromptSpec({
    sub_step: 'status',
    source: 'chatgpt-zip',
    pass1_chunks_done: 0,
  })
  expect(spec.body.toLowerCase()).not.toContain('max subscription')
  expect(spec.body.toLowerCase()).not.toContain('per-call cap')
})

test('2026-05-26 — is_rate_limit_cooling_off body still surfaces cooling-off framing (unchanged by the Max-OAuth leak removal)', () => {
  const spec = buildImportRunningPromptSpec({
    sub_step: 'status',
    source: 'claude-zip',
    pass1_chunks_done: 0,
    using_max_oauth_chunking: true,
    is_rate_limit_cooling_off: true,
  })
  expect(spec.body.toLowerCase()).toContain('cooling')
  expect(spec.body.toLowerCase()).toContain('rate limit')
  expect(spec.body.toLowerCase()).not.toContain('max subscription')
  expect(spec.body.toLowerCase()).not.toContain('per-call cap')
})

test('2026-05-26 — is_long_running body still surfaces the still-working framing (unchanged by the Max-OAuth leak removal)', () => {
  const spec = buildImportRunningPromptSpec({
    sub_step: 'status',
    source: 'chatgpt-zip',
    pass1_chunks_done: 0,
    using_max_oauth_chunking: true,
    is_long_running: true,
  })
  expect(spec.body.toLowerCase()).toContain('still working')
  expect(spec.body.toLowerCase()).not.toContain('max subscription')
  expect(spec.body.toLowerCase()).not.toContain('per-call cap')
})
