/**
 * @neutronai/onboarding/interview — onboarding preamble (Path 1) tests.
 *
 * M1 live-test fix (2026-06-29): the Claude/ChatGPT history import must be
 * offered as the EXPLICIT, EARLY first step — right after the name and BEFORE
 * the work questions — so the box can analyse the user's real history and the
 * rest of the interview is informed by it (onboarding-experience spec: upload
 * precedes the guided interview). The earlier preamble placed the offer after
 * all five learning goals + gated it "after you have their name AND a sense of
 * their work", so the model deferred it past the work-interview ("import is
 * buried"). These tests pin the new ordering so it can't silently regress.
 */

import { describe, expect, it } from 'bun:test'

import { buildOnboardingPreamble } from '../onboarding-preamble.ts'

describe('buildOnboardingPreamble — import offer ordering', () => {
  it('offers the import when import_offered is true', () => {
    const out = buildOnboardingPreamble({ import_offered: true })
    expect(out).toContain('import their existing ChatGPT')
    expect(out).toContain('drag-and-drop or attach the .zip')
    // EXPLICIT + EARLY framing — first move, after the name, before work.
    expect(out).toContain('as your very FIRST move')
    expect(out).toContain('BEFORE you ask')
  })

  it('positions the import offer BEFORE the "what they work on" goal', () => {
    const out = buildOnboardingPreamble({ import_offered: true })
    const offerIdx = out.indexOf('offer to import their existing ChatGPT')
    const workIdx = out.indexOf('What they work on')
    const nameIdx = out.indexOf('Their first name')
    expect(offerIdx).toBeGreaterThan(-1)
    expect(workIdx).toBeGreaterThan(-1)
    expect(nameIdx).toBeGreaterThan(-1)
    // name -> import offer -> work interview
    expect(offerIdx).toBeGreaterThan(nameIdx)
    expect(offerIdx).toBeLessThan(workIdx)
  })

  it('omits the import offer entirely when import_offered is false', () => {
    const out = buildOnboardingPreamble({ import_offered: false })
    expect(out).not.toContain('import their existing ChatGPT')
    expect(out).not.toContain('drag-and-drop')
    // The interview goals still render.
    expect(out).toContain('Their first name')
    expect(out).toContain('What they work on')
  })

  it('asks for the import only once (no duplicate offer blocks)', () => {
    const out = buildOnboardingPreamble({ import_offered: true })
    const occurrences = out.split('offer to import their existing ChatGPT').length - 1
    expect(occurrences).toBe(1)
    expect(out).toContain('only ask this once')
  })
})
