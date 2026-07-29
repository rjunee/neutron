/**
 * Ported from Nova `gateway/tests/session-validation.test.ts` (verbatim fs
 * logic). The JSONL-existence ghost-gate is the 2026-04-13 incident guard:
 * only a session UUID with a real transcript on disk is treated as resumable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dashifyCwd, validateAndPersistSessionId } from '../session-validation.ts'

describe('dashifyCwd', () => {
  it('dashes a cwd the way Claude Code names project dirs', () => {
    expect(dashifyCwd('/srv/neutron/owners/acme')).toBe('-srv-neutron-owners-acme')
  })
})

describe('validateAndPersistSessionId (ghost-session gate)', () => {
  let projects: string
  const cwd = '/srv/neutron/owners/acme'
  const dashed = '-srv-neutron-owners-acme'

  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'neutron-projects-'))
    mkdirSync(join(projects, dashed), { recursive: true })
  })
  afterEach(() => {
    rmSync(projects, { recursive: true, force: true })
  })

  it('returns false for an empty session id', () => {
    expect(validateAndPersistSessionId('', cwd, projects)).toBe(false)
  })

  it('returns false when no JSONL exists (ghost session)', () => {
    expect(validateAndPersistSessionId('ghost-uuid', cwd, projects)).toBe(false)
  })

  it('returns false when the JSONL exists but is empty', () => {
    writeFileSync(join(projects, dashed, 'empty-uuid.jsonl'), '   \n')
    expect(validateAndPersistSessionId('empty-uuid', cwd, projects)).toBe(false)
  })

  it('returns true when the JSONL exists with ≥1 line', () => {
    writeFileSync(join(projects, dashed, 'real-uuid.jsonl'), '{"type":"user"}\n')
    expect(validateAndPersistSessionId('real-uuid', cwd, projects)).toBe(true)
  })
})
