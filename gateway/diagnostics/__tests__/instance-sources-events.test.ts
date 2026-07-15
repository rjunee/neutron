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
})
