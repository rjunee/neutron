/**
 * O5 — DB-level proof that `buildInstanceDiagnosticsSources` wires O4's
 * operational `system_events` journal (NOT the old onboarding `gateway_events`
 * telemetry) into the `recent_events` section.
 *
 * The pure `composeDiagnostics` suite covers the SHAPE mapping; this suite
 * exercises the real read: write degrade rows via `SystemEventsStore` into a
 * migrated `project.db`, then assert the composed report surfaces them
 * newest-first with scope + payload intact. This is the behavioral test for the
 * "wire the real journal now O4 has merged" completion — a `core_install_failed`
 * degrade must be visible in diagnostics without journalctl.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, SystemEventsStore } from '@neutronai/persistence/index.ts'
import { composeDiagnostics } from '../diagnostics-report.ts'
import { buildInstanceDiagnosticsSources } from '../instance-sources.ts'

const SLUG = 'demo'
let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'diag-events-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function report(): ReturnType<typeof composeDiagnostics> {
  return composeDiagnostics(
    buildInstanceDiagnosticsSources({ db, project_slug: SLUG, owner_home: tmp }),
  )
}

describe('buildInstanceDiagnosticsSources — recent_events reads system_events', () => {
  it('surfaces a core_install_failed degrade row (newest first, with payload/scope)', async () => {
    const store = new SystemEventsStore({ db })
    // Two degrade rows on the journal; `listRecent` returns newest (ts DESC).
    await store.record({
      event: 'gbrain_unavailable',
      module: 'gbrain',
      level: 'warn',
      ts: 100,
      payload: { reason: 'not_init' },
    })
    await store.record({
      event: 'core_install_failed',
      module: 'cores',
      level: 'error',
      project_slug: SLUG,
      ts: 200,
      payload: { core_slug: 'email', code: 'manifest_invalid', message: 'boom' },
    })

    const ev = report().recent_events
    expect(ev.available).toBe(true)
    expect(ev.events!.map((e) => e.event)).toEqual(['core_install_failed', 'gbrain_unavailable'])
    expect(ev.events![0]).toMatchObject({
      ts: 200,
      level: 'error',
      module: 'cores',
      event: 'core_install_failed',
      project_slug: SLUG,
      payload: { core_slug: 'email', code: 'manifest_invalid', message: 'boom' },
    })
  })

  it('an empty journal is available with zero events (not a fault)', () => {
    const ev = report().recent_events
    expect(ev.available).toBe(true)
    expect(ev.events).toEqual([])
  })

  it('SCOPES to this slug + process-wide (NULL) rows — a foreign slug is neither disclosed nor allowed to starve in-scope rows', async () => {
    const store = new SystemEventsStore({ db })
    // In-scope (demo) + process-wide (NULL) rows.
    await store.record({
      event: 'core_install_failed',
      module: 'cores',
      level: 'error',
      project_slug: SLUG,
      ts: 100,
      payload: { core_slug: 'email' },
    })
    await store.record({ event: 'gbrain_unavailable', module: 'gbrain', level: 'warn', ts: 110 }) // NULL scope
    // A FOREIGN-slug row that is the NEWEST — under an UNSCOPED `LIMIT` it would
    // both leak into this instance's report AND (with a tight limit) starve the
    // in-scope rows out of the window.
    await store.record({
      event: 'credential_all_cooldown',
      module: 'credentials',
      level: 'error',
      project_slug: 'other-slug',
      ts: 999,
      payload: { secret: 'must-not-leak' },
    })

    // Tight limit (2) so the newest foreign row WOULD displace an in-scope row if unscoped.
    const ev = composeDiagnostics(
      buildInstanceDiagnosticsSources({ db, project_slug: SLUG, owner_home: tmp, maxRecentEvents: 2 }),
    ).recent_events
    expect(ev.available).toBe(true)
    const events = ev.events!
    // No cross-project disclosure — the foreign slug never appears.
    expect(events.some((e) => e.project_slug === 'other-slug')).toBe(false)
    // Both in-scope + process-wide rows survive (foreign didn't starve them).
    expect(events.map((e) => e.event).sort()).toEqual(['core_install_failed', 'gbrain_unavailable'])
  })
})
