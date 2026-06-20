/**
 * Ported from Nova `gateway/tests/resume-invariant.test.ts` (★ verbatim).
 * resolveRespawnStrategy is a pure function lifted unchanged — the three-tier
 * fallback chain (stored UUID → scanned UUID → legacy name → fresh) is the
 * respawn-is-always-resume invariant the Sprint-2 respawn path builds on.
 */

import { describe, it, expect } from 'bun:test'
import { resolveRespawnStrategy } from '../respawn-strategy.ts'

describe('resolveRespawnStrategy (respawn-is-always-resume)', () => {
  it('prefers a stored session_id UUID', () => {
    const r = resolveRespawnStrategy({ session_id: 'uuid-stored', has_session: true })
    expect(r.strategy).toBe('session-id')
    expect(r.sessionId).toBe('uuid-stored')
    expect(r.resumable).toBe(true)
  })

  it('stored UUID wins even over a freshly-scanned one', () => {
    const r = resolveRespawnStrategy({ session_id: 'uuid-stored', has_session: true }, 'uuid-scanned')
    expect(r.sessionId).toBe('uuid-stored')
  })

  it('uses a scanned UUID when none is stored', () => {
    const r = resolveRespawnStrategy({ has_session: true }, 'uuid-scanned')
    expect(r.strategy).toBe('session-id')
    expect(r.sessionId).toBe('uuid-scanned')
    expect(r.resumable).toBe(true)
  })

  it('falls back to legacy session-name when only a name + has_session exist', () => {
    const r = resolveRespawnStrategy({ has_session: true, session_name: 'legacy-name' })
    expect(r.strategy).toBe('session-name')
    expect(r.resumable).toBe(true)
    expect(r.sessionId).toBeUndefined()
  })

  it('falls back to fresh (non-resumable) when nothing is known', () => {
    const r = resolveRespawnStrategy({ has_session: false })
    expect(r.strategy).toBe('fresh')
    expect(r.resumable).toBe(false)
  })

  it('a name without has_session is NOT resumable → fresh', () => {
    const r = resolveRespawnStrategy({ has_session: false, session_name: 'orphan' })
    expect(r.strategy).toBe('fresh')
    expect(r.resumable).toBe(false)
  })
})
