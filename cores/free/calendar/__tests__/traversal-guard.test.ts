/**
 * Refactor X4 (item 2 — `[BEHAVIOR]` security fix). Before X4 the Calendar
 * Core's pre-meeting-brief queue store did a BARE `join()` on the
 * tool-supplied `project_id`. Its `sanitizeProjectId` charset
 * (`[A-Za-z0-9_.-]`) already rejected `/` and NUL, but bare `..`/`.` slipped
 * through it and would escape `<owner_home>/Projects/`. The store now also
 * routes `project_id` through the universal `safeResolveProjectRoot` guard,
 * closing that gap. These tests prove BOTH layers reject every escape vector
 * and that legit ids still resolve.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CorePathTraversalError } from '@neutronai/cores-runtime'

import { SqlitePreMeetingBriefQueueStore } from '../src/pre-meeting-brief-queue-store.ts'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'calendar-traversal-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('Calendar queue store — path-traversal guard (X4 [BEHAVIOR])', () => {
  test('universal guard rejects bare ".." and "." (the charset gap)', async () => {
    const store = new SqlitePreMeetingBriefQueueStore({ owner_home: home })
    await expect(store.listPending('..')).rejects.toThrow(CorePathTraversalError)
    await expect(store.listPending('.')).rejects.toThrow(CorePathTraversalError)
    store.closeAll()
  })

  test('charset layer still rejects ../, NUL, and absolute-path ids', async () => {
    const store = new SqlitePreMeetingBriefQueueStore({ owner_home: home })
    // These carry `/` or NUL → rejected by `sanitizeProjectId` before the
    // FS-touching guard even runs. Either way: rejected, no escape.
    await expect(store.listPending('../../../etc/passwd')).rejects.toThrow()
    await expect(store.listPending('proj\0evil')).rejects.toThrow()
    await expect(store.listPending('/etc/passwd')).rejects.toThrow()
    // No sidecar dir created outside the boundary.
    expect(existsSync(join(home, 'calendar'))).toBe(false)
    store.closeAll()
  })

  test('accepts legit slugs + uuids', async () => {
    const store = new SqlitePreMeetingBriefQueueStore({ owner_home: home })
    for (const id of ['proj-a', '5f2c9e8a-2b1d-4c3e-9a7f-0b1c2d3e4f50']) {
      const rows = await store.listPending(id)
      expect(Array.isArray(rows)).toBe(true)
      expect(existsSync(join(home, 'Projects', id, 'calendar'))).toBe(true)
    }
    store.closeAll()
  })
})
