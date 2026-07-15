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
import {
  ProjectDb,
  SystemEventsStore,
  emitSystemEvent,
  registerSystemEventSink,
} from '@neutronai/persistence/index.ts'
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
  registerSystemEventSink(null)
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function report(): ReturnType<typeof composeDiagnostics> {
  return composeDiagnostics(
    buildInstanceDiagnosticsSources({ db, project_slug: SLUG, owner_home: tmp }),
  )
}

describe('buildInstanceDiagnosticsSources — recent_events reads system_events', () => {
  it('surfaces a scoped core_install_failed degrade row (newest first, with payload/scope)', async () => {
    const store = new SystemEventsStore({ db })
    // A NULL-scoped row (excluded — NULL is ambiguous) + two SCOPED degrade rows.
    await store.record({
      event: 'gbrain_unavailable',
      module: 'gbrain',
      level: 'warn',
      ts: 100,
      payload: { reason: 'not_init' }, // NULL scope → excluded from an instance-scoped read
    })
    await store.record({
      event: 'cron_job_error',
      module: 'cron',
      level: 'error',
      project_slug: SLUG,
      ts: 150,
      payload: { job: 'digest' },
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
    // NULL-scoped gbrain row is NOT disclosed; the two SLUG rows are, newest first.
    expect(ev.events!.map((e) => e.event)).toEqual(['core_install_failed', 'cron_job_error'])
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

  it('STRICTLY scopes to this slug — neither a foreign slug NOR an ambiguous NULL row is disclosed', async () => {
    const store = new SystemEventsStore({ db })
    // In-scope (demo) row.
    await store.record({
      event: 'core_install_failed',
      module: 'cores',
      level: 'error',
      project_slug: SLUG,
      ts: 100,
      payload: { core_slug: 'email' },
    })
    // A NULL-scoped row that carries an instance-specific identifier — this is the
    // exact leak vector: an emitter that omitted its scope. It must NOT be disclosed
    // into an instance-scoped report.
    await store.record({
      event: 'import_orphaned',
      module: 'onboarding',
      level: 'error',
      ts: 110,
      payload: { job_id: 'other-project-secret' }, // NULL scope
    })
    // A FOREIGN-slug row that is the NEWEST — under an UNSCOPED `LIMIT` it would
    // both leak into this instance's report AND (with a tight limit) starve the
    // in-scope row out of the window.
    await store.record({
      event: 'credential_all_cooldown',
      module: 'credentials',
      level: 'error',
      project_slug: 'other-slug',
      ts: 999,
      payload: { secret: 'must-not-leak' },
    })

    // Tight limit (2) so the newest foreign/NULL rows WOULD displace the in-scope row if unscoped.
    const ev = composeDiagnostics(
      buildInstanceDiagnosticsSources({ db, project_slug: SLUG, owner_home: tmp, maxRecentEvents: 2 }),
    ).recent_events
    expect(ev.available).toBe(true)
    const events = ev.events!
    // No cross-project disclosure — neither the foreign slug nor the NULL-scoped row appears.
    expect(events.some((e) => e.project_slug === 'other-slug')).toBe(false)
    expect(events.some((e) => e.event === 'import_orphaned')).toBe(false)
    // Only the in-scope row survives.
    expect(events.map((e) => e.event)).toEqual(['core_install_failed'])
  })

  it('a row from the REAL emitter path is excluded — import_orphaned emits NULL scope', async () => {
    // Reproduce the PRODUCTION shape: `import_orphaned` is emitted via the ambient
    // `emitSystemEvent` helper WITHOUT a project_slug (onboarding/interview/
    // engine-import-routing.ts), so it lands NULL-scoped — the exact leak vector.
    const store = new SystemEventsStore({ db })
    registerSystemEventSink(store)
    // A project-scoped degrade DOES surface, as a control.
    await store.record({
      event: 'core_install_failed',
      module: 'cores',
      level: 'error',
      project_slug: SLUG,
      ts: 300,
      payload: { core_slug: 'email' },
    })
    // Emit through the SAME helper production uses — omitting project_slug.
    await emitSystemEvent({
      event: 'import_orphaned',
      module: 'onboarding',
      level: 'error',
      ts: 310,
      payload: { job_id: 'j-42', source: 'gmail', phase: 'import_running' },
    })
    await store.drain()

    const ev = report().recent_events
    expect(ev.available).toBe(true)
    // The real NULL-scoped emitter row is NOT disclosed; only the scoped row shows.
    expect(ev.events!.some((e) => e.event === 'import_orphaned')).toBe(false)
    expect(ev.events!.map((e) => e.event)).toEqual(['core_install_failed'])
  })
})
