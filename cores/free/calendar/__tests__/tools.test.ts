import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  CapabilityDeniedError,
  CapabilityGuard,
  SecretAuditLog,
} from '@neutronai/cores-runtime'
import type { NeutronManifest } from '@neutronai/cores-sdk'

import { applyMigrations } from '../../../../migrations/runner.ts'
import { ProjectDb } from '../../../../persistence/index.ts'

import {
  EventNotFoundError,
  buildInMemoryCalendarClient,
  buildTools,
  loadManifest,
} from '../index.ts'

let tmp: string
let projectDb: ProjectDb
let audit: SecretAuditLog
const OWNER = 't1'

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'calendar-core-tools-'))
  const dbPath = join(tmp, 'project.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  projectDb = ProjectDb.open(dbPath)
  audit = new SecretAuditLog({ db: projectDb })
})

afterEach(() => {
  projectDb.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Deterministic id helper — the in-memory client mints `cal-0`, `cal-1`,
 * ... so the assertions don't depend on `randomUUID()`.
 */
function buildFixtures() {
  let nextN = 0
  const nextId = (): string => `cal-${nextN++}`
  return {
    client: buildInMemoryCalendarClient({ nextId }),
  }
}

describe('buildTools — capability-gated dispatch', () => {
  test('calendar_create + calendar_list round-trip via the in-memory client', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    const created = await tools.calendar_create({
      title: 'kickoff with Casey',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
      attendees: ['casey@example.com'],
    })
    expect(created.id).toBe('cal-0')
    expect(created.event.title).toBe('kickoff with Casey')
    expect(created.event.calendar_id).toBe('primary')
    expect(created.event.status).toBe('confirmed')
    expect(created.event.attendees).toEqual(['casey@example.com'])

    const created2 = await tools.calendar_create({
      title: 'review with Priya',
      start: '2026-06-02T15:00:00Z',
      end: '2026-06-02T16:00:00Z',
      description: '- intake call\n- compliance checklist',
    })
    expect(created2.event.title).toBe('review with Priya')

    const list = await tools.calendar_list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-03T00:00:00Z',
    })
    // CHRONOLOGICAL ASCENDING from range_start — forward-looking.
    expect(list.results.map((r) => r.id)).toEqual(['cal-0', 'cal-1'])

    // Every successful dispatch writes an audit row.
    const auditRows = await audit.list({
      project_slug: OWNER,
      core_slug: 'calendar_core',
    })
    const successRows = auditRows.filter((r) => r.outcome === 'ok')
    expect(successRows.length).toBeGreaterThanOrEqual(3)
    const toolNames = new Set(successRows.map((r) => r.label))
    expect(toolNames.has('calendar_create')).toBe(true)
    expect(toolNames.has('calendar_list')).toBe(true)
  })

  test('calendar_list ordering is chronological ascending from range_start, NOT created-order', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    // Insert in a different order than the eventual list ordering: the
    // latest-created event has the EARLIEST start time. A naive newest-
    // first ordering (the Notes/Tasks convention) would surface them
    // reversed; the Calendar Core's forward-looking gate rejects that.
    await tools.calendar_create({
      title: 'C — last',
      start: '2026-06-10T09:00:00Z',
      end: '2026-06-10T10:00:00Z',
    })
    await tools.calendar_create({
      title: 'B — middle',
      start: '2026-06-05T09:00:00Z',
      end: '2026-06-05T10:00:00Z',
    })
    await tools.calendar_create({
      title: 'A — first',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
    })

    const list = await tools.calendar_list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-30T00:00:00Z',
    })
    expect(list.results.map((r) => r.title)).toEqual([
      'A — first',
      'B — middle',
      'C — last',
    ])
  })

  test('calendar_list filters by range window', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    await tools.calendar_create({
      title: 'before window',
      start: '2026-05-31T09:00:00Z',
      end: '2026-05-31T10:00:00Z',
    })
    await tools.calendar_create({
      title: 'inside window',
      start: '2026-06-15T09:00:00Z',
      end: '2026-06-15T10:00:00Z',
    })
    await tools.calendar_create({
      title: 'after window',
      start: '2026-07-01T09:00:00Z',
      end: '2026-07-01T10:00:00Z',
    })

    const list = await tools.calendar_list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-07-01T00:00:00Z',
    })
    expect(list.results.map((r) => r.title)).toEqual(['inside window'])
  })

  test('calendar_update patches arbitrary fields + persists across reads', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    const { id } = await tools.calendar_create({
      title: 'kickoff',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
    })

    const updated = await tools.calendar_update({
      event_id: id,
      fields: {
        title: 'kickoff rescheduled',
        start: '2026-06-01T10:30:00Z',
        end: '2026-06-01T11:30:00Z',
        attendees: ['casey@example.com', 'morgan@example.com'],
      },
    })
    expect(updated.event.title).toBe('kickoff rescheduled')
    expect(updated.event.start).toBe('2026-06-01T10:30:00Z')
    expect(updated.event.end).toBe('2026-06-01T11:30:00Z')
    expect(updated.event.attendees).toEqual([
      'casey@example.com',
      'morgan@example.com',
    ])

    const after = await tools.calendar_list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-02T00:00:00Z',
    })
    expect(after.results[0]?.title).toBe('kickoff rescheduled')
    expect(after.results[0]?.start).toBe('2026-06-01T10:30:00Z')
  })

  test('calendar_cancel removes the event from list + downstream reads ignore it', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    const a = await tools.calendar_create({
      title: 'a',
      start: '2026-06-01T09:00:00Z',
      end: '2026-06-01T10:00:00Z',
    })
    const b = await tools.calendar_create({
      title: 'b',
      start: '2026-06-02T09:00:00Z',
      end: '2026-06-02T10:00:00Z',
    })

    const result = await tools.calendar_cancel({ event_id: a.id })
    expect(result.ok).toBe(true)
    expect(result.event_id).toBe(a.id)

    const list = await tools.calendar_list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-03T00:00:00Z',
    })
    expect(list.results.map((r) => r.id)).toEqual([b.id])

    // Cancelling a non-existent event throws EventNotFoundError (guard
    // wrapper records an `error` outcome and re-throws).
    await expect(tools.calendar_cancel({ event_id: 'missing' })).rejects.toThrow(
      EventNotFoundError,
    )
  })

  test('calendar_brief returns the expected structured shape', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    const { id } = await tools.calendar_create({
      title: 'compliance review',
      start: '2026-06-04T14:00:00Z',
      end: '2026-06-04T15:30:00Z',
      attendees: ['priya@example.com', 'casey@example.com'],
      description: [
        'Agenda for the call:',
        '- intake checklist',
        '- engagement-letter draft',
        '* Heppner-resistant artifact set',
        'Notes:',
        '1. confirm next session',
        '1) tentative date 2026-06-11',
      ].join('\n'),
    })

    const brief = await tools.calendar_brief({ event_id: id })
    expect(brief.brief.event_id).toBe(id)
    expect(brief.brief.title).toBe('compliance review')
    expect(brief.brief.start).toBe('2026-06-04T14:00:00Z')
    expect(brief.brief.end).toBe('2026-06-04T15:30:00Z')
    expect(brief.brief.duration_minutes).toBe(90)
    expect(brief.brief.attendees).toEqual([
      'priya@example.com',
      'casey@example.com',
    ])
    // Bulleted lines surface as agenda items; freeform "Notes:" line
    // is dropped (no leading bullet); numbered "1." and "1)" lines
    // also surface.
    expect(brief.brief.agenda).toEqual([
      'intake checklist',
      'engagement-letter draft',
      'Heppner-resistant artifact set',
      'confirm next session',
      'tentative date 2026-06-11',
    ])
    // v1 prior_context is the empty-array structural placeholder.
    expect(brief.brief.prior_context).toEqual([])
  })

  test('calendar_brief surfaces EventNotFoundError when the event id is unknown', async () => {
    const { client } = buildFixtures()
    const manifest = loadManifest()
    const tools = buildTools({ manifest, project_slug: OWNER, audit, client })

    await expect(
      tools.calendar_brief({ event_id: 'does-not-exist' }),
    ).rejects.toThrow(EventNotFoundError)
  })

  test('capability gate: stripped write capability rejects every write tool, leaves read tools intact', async () => {
    const { client } = buildFixtures()
    // Synthesise a manifest with all five tool entries but strip
    // `write:calendar_core.events` from the capabilities[] array. The
    // guard must reject create/update/cancel; list + brief still work.
    const m0 = loadManifest()
    const downgraded: NeutronManifest = {
      ...m0,
      capabilities: m0.capabilities.filter(
        (c) => c !== 'write:calendar_core.events',
      ),
    }
    const tools = buildTools({
      manifest: downgraded,
      project_slug: OWNER,
      audit,
      client,
    })

    await expect(
      tools.calendar_create({
        title: 'x',
        start: '2026-06-01T09:00:00Z',
        end: '2026-06-01T10:00:00Z',
      }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.calendar_update({ event_id: 'cal-0', fields: { title: 'y' } }),
    ).rejects.toThrow(CapabilityDeniedError)
    await expect(
      tools.calendar_cancel({ event_id: 'cal-0' }),
    ).rejects.toThrow(CapabilityDeniedError)

    // Read tools still work — `read:calendar_core.events` is still declared.
    const list = await tools.calendar_list({
      range_start: '2026-06-01T00:00:00Z',
      range_end: '2026-06-02T00:00:00Z',
    })
    expect(list.results).toEqual([])

    const denied = await audit.listDenied({
      project_slug: OWNER,
      core_slug: 'calendar_core',
    })
    const labels = new Set(denied.map((r) => r.label))
    expect(labels.has('calendar_create')).toBe(true)
    expect(labels.has('calendar_update')).toBe(true)
    expect(labels.has('calendar_cancel')).toBe(true)
    expect(labels.has('calendar_list')).toBe(false)
    expect(labels.has('calendar_brief')).toBe(false)
  })

  test('capability gate: undeclared tool name is rejected by `tool_not_declared`', async () => {
    // Build a guard directly + assert against an undeclared tool. The
    // wrapped handlers exposed by `buildTools` use only the five tool
    // names declared in the manifest, so this verifies the underlying
    // gate behaviour for completeness.
    const m = loadManifest()
    const guard = new CapabilityGuard({
      manifest: m,
      core_slug: 'calendar_core',
      project_slug: OWNER,
      audit,
    })

    const result = guard.check({
      tool_name: 'calendar_unknown_tool',
      capability_required: 'write:calendar_core.events',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('tool_not_declared')
    }
  })
})
