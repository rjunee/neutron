/**
 * session-disk-recovery.test.ts — the DISK-RECOVERY half of the resume-session-
 * failure safety net (master-table row #7). Pins the JSONL-is-truth invariant
 * (§5): only a transcript that exists with ≥1 non-empty line is a candidate, and
 * the most-recently-modified one wins (the session the user was last in). The
 * stale id that dropped us into the picker is excludable so we never "recover"
 * the very session that just failed to resume.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findLatestResumableSession } from '../session-disk-recovery.ts'

describe('findLatestResumableSession', () => {
  let projects: string
  const cwd = '/srv/neutron/owners/acme'
  const dashed = '-srv-neutron-owners-acme'

  /** Write a transcript with the given content + mtime (seconds since epoch). */
  function writeSession(id: string, content: string, mtimeSec: number): void {
    const path = join(projects, dashed, `${id}.jsonl`)
    writeFileSync(path, content)
    utimesSync(path, mtimeSec, mtimeSec)
  }

  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'neutron-disk-recovery-'))
    mkdirSync(join(projects, dashed), { recursive: true })
  })
  afterEach(() => {
    rmSync(projects, { recursive: true, force: true })
  })

  it('returns null when the project dir does not exist', () => {
    expect(findLatestResumableSession('/no/such/cwd', projects)).toBeNull()
  })

  it('returns null when no transcripts exist', () => {
    expect(findLatestResumableSession(cwd, projects)).toBeNull()
  })

  it('returns the only real session', () => {
    writeSession('only-uuid', '{"type":"user"}\n', 1_000_000)
    expect(findLatestResumableSession(cwd, projects)).toBe('only-uuid')
  })

  it('picks the most-recently-modified transcript', () => {
    writeSession('older-uuid', '{"type":"user"}\n', 1_000_000)
    writeSession('newer-uuid', '{"type":"user"}\n', 2_000_000)
    writeSession('middle-uuid', '{"type":"user"}\n', 1_500_000)
    expect(findLatestResumableSession(cwd, projects)).toBe('newer-uuid')
  })

  it('skips empty / whitespace-only transcripts (the ghost guard, §5)', () => {
    // The newest by mtime is a ghost (empty) → must be skipped for the real one.
    writeSession('real-uuid', '{"type":"user"}\n', 1_000_000)
    writeSession('ghost-uuid', '   \n', 2_000_000)
    expect(findLatestResumableSession(cwd, projects)).toBe('real-uuid')
  })

  it('ignores non-jsonl files', () => {
    writeSession('real-uuid', '{"type":"user"}\n', 1_000_000)
    writeFileSync(join(projects, dashed, 'notes.txt'), 'newer but not a transcript')
    utimesSync(join(projects, dashed, 'notes.txt'), 9_000_000, 9_000_000)
    expect(findLatestResumableSession(cwd, projects)).toBe('real-uuid')
  })

  it('excludes the stale id that just failed to resume', () => {
    // The stale id is the newest, but excluding it falls back to the next real one.
    writeSession('stale-uuid', '{"type":"user"}\n', 2_000_000)
    writeSession('good-uuid', '{"type":"user"}\n', 1_000_000)
    expect(
      findLatestResumableSession(cwd, projects, { excludeSessionId: 'stale-uuid' }),
    ).toBe('good-uuid')
  })

  it('returns null when the only session is the excluded stale id', () => {
    writeSession('stale-uuid', '{"type":"user"}\n', 2_000_000)
    expect(
      findLatestResumableSession(cwd, projects, { excludeSessionId: 'stale-uuid' }),
    ).toBeNull()
  })
})
