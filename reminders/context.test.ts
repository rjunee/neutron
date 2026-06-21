import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildStatusMdContextSource } from './context.ts'
import type { Reminder } from './store.ts'

let owner_home: string

function reminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r',
    project_slug: 'instance-slug',
    topic_id: null,
    fire_at: 0,
    message: 'm',
    status: 'pending',
    recurrence: null,
    source: null,
    created_at: 0,
    fired_at: null,
    cancelled_at: null,
    ...over,
  }
}

function writeStatus(project_id: string, body: string): void {
  const dir = join(owner_home, 'Projects', project_id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'STATUS.md'), body, 'utf8')
}

beforeEach(() => {
  owner_home = mkdtempSync(join(tmpdir(), 'neutron-reminder-ctx-'))
})

afterEach(() => {
  rmSync(owner_home, { recursive: true, force: true })
})

describe('buildStatusMdContextSource', () => {
  // BLOCKING fix (Argus PR #7) — the source reads the DESTINATION project's
  // STATUS.md (the project_id passed by the dispatcher), NOT the instance slug.
  test('reads the destination project STATUS.md, not the instance slug', () => {
    writeStatus('acme-app', 'Launch is T-2 days')
    writeStatus('instance-slug', 'WRONG — instance status')
    const src = buildStatusMdContextSource({ owner_home })

    const ctx = src.gather(reminder({ project_slug: 'instance-slug' }), 'acme-app') as string

    expect(ctx).toContain('Launch is T-2 days')
    expect(ctx).toContain('acme-app')
    expect(ctx).not.toContain('WRONG')
  })

  test('absent STATUS.md → empty context (degrade-safe, no throw)', () => {
    const src = buildStatusMdContextSource({ owner_home })
    expect(src.gather(reminder(), 'no-such-project')).toBe('')
  })

  test('clips oversize STATUS.md to the char cap', () => {
    writeStatus('big', 'x'.repeat(10_000))
    const src = buildStatusMdContextSource({ owner_home, char_cap: 100 })
    const ctx = src.gather(reminder(), 'big') as string
    expect(ctx).toContain('…(truncated)')
    expect(ctx.length).toBeLessThan(300)
  })

  test('rejects a traversal-laden project id without reading outside Projects/', () => {
    // Plant a STATUS.md two dirs up — a `../../` id would reach it if unguarded.
    writeFileSync(join(owner_home, 'STATUS.md'), 'SECRET owner-home status', 'utf8')
    const src = buildStatusMdContextSource({ owner_home })

    const ctx = src.gather(reminder(), '../../') as string

    expect(ctx).toBe('')
  })

  test('rejects a project id with path separators', () => {
    writeStatus('acme', 'real status')
    const src = buildStatusMdContextSource({ owner_home })
    // A slash-bearing id is not a valid project id — sanitize rejects it.
    expect(src.gather(reminder(), 'acme/../acme')).toBe('')
  })
})
