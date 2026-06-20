/**
 * Sprint A — composer regression tests.
 * Plan: docs/plans/2026-05-09-gbrain-methodology-integration-v2.md § 9.1.
 *
 * Two surfaces under test:
 *   - `composeSystemPrompt` is byte-identical to `base` when conventions
 *     is empty / undefined / null (back-compat for pre-Sprint-A owners)
 *   - Loaded conventions appear in the composed prompt under a stable
 *     `# Conventions` header, ABOVE the upstream system prompt
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeSystemPrompt, loadSkills } from '../index.ts'
import { _resetSkillsLoaderCache as resetCache } from '../skills-loader.ts'

let tmpRoot: string

beforeEach(() => {
  resetCache()
  tmpRoot = mkdtempSync(join(tmpdir(), 'composer-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const BASE = `You are the onboarding agent.\nPhase: signup\nGoal: ask for the user's name.`

test('byte-identical to base when conventions is undefined', () => {
  expect(composeSystemPrompt({ base: BASE })).toBe(BASE)
})

test('byte-identical to base when conventions is null', () => {
  expect(composeSystemPrompt({ base: BASE, conventions: null })).toBe(BASE)
})

test('byte-identical to base when conventions is an empty string', () => {
  expect(composeSystemPrompt({ base: BASE, conventions: '' })).toBe(BASE)
})

test('splices conventions under a `# Conventions` header above the base', () => {
  const out = composeSystemPrompt({
    base: BASE,
    conventions: 'BRAIN_FIRST_BODY',
  })
  expect(out).toContain('# Conventions')
  expect(out).toContain('BRAIN_FIRST_BODY')
  expect(out).toContain(BASE)
  // Conventions block must come BEFORE the base prompt so the cache
  // anchor stays stable when conventions don't change between turns.
  expect(out.indexOf('# Conventions')).toBeLessThan(out.indexOf(BASE))
})

test('end-to-end: loaded skills appear in composed prompt', async () => {
  const skillsDir = join(tmpRoot, 'skills')
  mkdirSync(join(skillsDir, 'conventions'), { recursive: true })
  writeFileSync(
    join(skillsDir, 'conventions', 'brain-first.md'),
    'Always look in the brain first.\n',
    'utf8',
  )
  writeFileSync(
    join(skillsDir, 'conventions', 'friction-protocol.md'),
    'Log friction via gbrain friction log.\n',
    'utf8',
  )
  writeFileSync(
    join(skillsDir, 'conventions', 'brain-vs-memory.md'),
    'Brain is world knowledge. Memory is operations.\n',
    'utf8',
  )
  writeFileSync(
    join(skillsDir, 'conventions', 'quality.md'),
    'Every fact carries an inline citation.\n',
    'utf8',
  )

  const skills = await loadSkills({ skillsDir })
  const composed = composeSystemPrompt({ base: BASE, conventions: skills.body })

  // Sprint A gate 3: composed prompt contains substrings from each of
  // the four convention files.
  expect(composed).toContain('Always look in the brain first.')
  expect(composed).toContain('Log friction via gbrain friction log.')
  expect(composed).toContain('Brain is world knowledge. Memory is operations.')
  expect(composed).toContain('Every fact carries an inline citation.')

  // Base preserved.
  expect(composed).toContain(BASE)
})

test('regression-pin: empty skills directory yields a composed prompt byte-identical to base', async () => {
  const skillsDir = join(tmpRoot, 'skills')
  // Don't create the directory — back-compat pre-Sprint-A instance.
  const skills = await loadSkills({ skillsDir })
  const composed = composeSystemPrompt({ base: BASE, conventions: skills.body })
  expect(composed).toBe(BASE)
})

// ─── ISSUE #30 — persona block splicing ──────────────────────────────────

test('byte-identical to base when persona is undefined AND conventions is undefined', () => {
  expect(composeSystemPrompt({ base: BASE })).toBe(BASE)
})

test('byte-identical to base when persona is null AND conventions is null', () => {
  expect(composeSystemPrompt({ base: BASE, persona: null, conventions: null })).toBe(BASE)
})

test('byte-identical to base when persona is an empty string AND conventions is empty', () => {
  expect(composeSystemPrompt({ base: BASE, persona: '', conventions: '' })).toBe(BASE)
})

test('splices persona under a `# Persona` header above the base', () => {
  const out = composeSystemPrompt({
    base: BASE,
    persona: 'PERSONA_BODY',
  })
  expect(out).toContain('# Persona')
  expect(out).toContain('PERSONA_BODY')
  expect(out).toContain(BASE)
  // Persona block must come BEFORE the base prompt — identity primes the
  // base, and the cache anchor stays stable when persona doesn't change.
  expect(out.indexOf('# Persona')).toBeLessThan(out.indexOf(BASE))
})

test('persona block sits ABOVE conventions block (identity primes methodology)', () => {
  const out = composeSystemPrompt({
    base: BASE,
    persona: 'PERSONA_BODY',
    conventions: 'CONVENTIONS_BODY',
  })
  expect(out).toContain('# Persona')
  expect(out).toContain('# Conventions')
  expect(out).toContain('PERSONA_BODY')
  expect(out).toContain('CONVENTIONS_BODY')
  expect(out).toContain(BASE)
  // Order: persona → conventions → base
  expect(out.indexOf('# Persona')).toBeLessThan(out.indexOf('# Conventions'))
  expect(out.indexOf('# Conventions')).toBeLessThan(out.indexOf(BASE))
})

test('persona splices alone when conventions is empty', () => {
  const out = composeSystemPrompt({
    base: BASE,
    persona: 'PERSONA_BODY',
    conventions: '',
  })
  expect(out).toContain('# Persona')
  expect(out).toContain('PERSONA_BODY')
  expect(out).not.toContain('# Conventions')
  expect(out).toContain(BASE)
})

test('conventions splices alone when persona is empty (no regression to Sprint A)', () => {
  const out = composeSystemPrompt({
    base: BASE,
    persona: '',
    conventions: 'CONVENTIONS_BODY',
  })
  expect(out).toContain('# Conventions')
  expect(out).toContain('CONVENTIONS_BODY')
  expect(out).not.toContain('# Persona')
  expect(out).toContain(BASE)
})

test('trailing newlines on persona are stripped to avoid blank-line drift', () => {
  // The composer normalises trailing newlines on both blocks so the
  // joined output stays byte-stable across callers that do/don't
  // terminate their input strings.
  const out = composeSystemPrompt({
    base: BASE,
    persona: 'PERSONA_BODY\n',
  })
  // Spliced under header — no double-blank between body and separator.
  expect(out).toContain('# Persona\n\nPERSONA_BODY\n\n---')
})
