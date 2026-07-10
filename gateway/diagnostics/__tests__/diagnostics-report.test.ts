/**
 * O5 — pure `composeDiagnostics` unit tests. No DB, no process: the composer
 * takes structural inputs and must (a) map each section faithfully, (b) render
 * `{ available: false }` for omitted sources, and (c) fail-soft when a single
 * source throws (that ONE section degrades; the report still returns).
 */

import { describe, expect, it } from 'bun:test'
import { composeDiagnostics, type DiagnosticsSources } from '../diagnostics-report.ts'

const FIXED_NOW = 1_000_000_000

function baseSources(over: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return { project_slug: 'demo', now: () => FIXED_NOW, ...over }
}

describe('composeDiagnostics', () => {
  it('renders every section available:false when no sources are wired', () => {
    const r = composeDiagnostics(baseSources())
    expect(r.project_slug).toBe('demo')
    expect(r.generated_at).toBe(FIXED_NOW)
    for (const s of [
      r.gbrain,
      r.credentials,
      r.repl_sessions,
      r.cron_jobs,
      r.import_jobs,
      r.recent_events,
    ]) {
      expect(s.available).toBe(false)
      expect(s.note).toBe('not wired on this gateway')
    }
  })

  it('maps the gbrain latch row', () => {
    const r = composeDiagnostics(
      baseSources({
        gbrain: () => ({
          status: 'unavailable',
          latchReason: 'GBrainUnavailableError',
          latchedAt: '2026-07-01T00:00:00.000Z',
          lastSuccessAt: '2026-06-30T00:00:00.000Z',
          deferredCount: 7,
          updatedAt: '2026-07-01T00:00:01.000Z',
        }),
      }),
    )
    expect(r.gbrain.available).toBe(true)
    expect(r.gbrain.status).toBe('unavailable')
    expect(r.gbrain.latch_reason).toBe('GBrainUnavailableError')
    expect(r.gbrain.deferred_count).toBe(7)
  })

  it('treats a null gbrain row as available with a "no state yet" note', () => {
    const r = composeDiagnostics(baseSources({ gbrain: () => null }))
    expect(r.gbrain.available).toBe(true)
    expect(r.gbrain.status).toBeUndefined()
    expect(r.gbrain.note).toContain('no sync state')
  })

  it('maps credential probes', () => {
    const usable = composeDiagnostics(
      baseSources({ credentials: () => ({ hasUsable: true, soonestCooldownUntil: null }) }),
    )
    expect(usable.credentials).toMatchObject({ available: true, has_usable: true, soonest_cooldown_until: null })

    const cooling = composeDiagnostics(
      baseSources({ credentials: () => ({ hasUsable: false, soonestCooldownUntil: 42 }) }),
    )
    expect(cooling.credentials).toMatchObject({ available: true, has_usable: false, soonest_cooldown_until: 42 })
  })

  it('maps REPL sessions incl. age, respawn count, capped_at', () => {
    const r = composeDiagnostics(
      baseSources({
        replRegistry: () => ({
          path: '/home/.neutron/repl-registry.json',
          records: {
            'sess-a': {
              sessionId: 'uuid-a',
              channelName: 'chan-a',
              has_session: true,
              model: 'sonnet',
              first_ready_at: FIXED_NOW - 5000,
              recent_respawns: [1, 2, 3],
              capped_at: 999,
            },
          },
        }),
      }),
    )
    expect(r.repl_sessions.available).toBe(true)
    expect(r.repl_sessions.registry_path).toBe('/home/.neutron/repl-registry.json')
    const s = r.repl_sessions.sessions![0]!
    expect(s.key).toBe('sess-a')
    expect(s.respawn_count).toBe(3)
    expect(s.age_ms).toBe(5000)
    expect(s.capped_at).toBe(999)
  })

  it('maps cron jobs and import jobs', () => {
    const r = composeDiagnostics(
      baseSources({
        cronJobs: () => [
          // last_run_at is Unix SECONDS in cron_state → composer must emit epoch-MS.
          { job_name: 'nudge', project_slug: 'demo', last_run_at: 1_710_000_000, last_run_status: 'ok', last_run_error: null, last_run_duration_ms: 5 },
        ],
        importJobs: () => [
          { job_id: 'j1', source: 'chatgpt', status: 'failed', started_at: 1, completed_at: 2, error_code: 'rate_limit', error_message: 'slow down' },
        ],
      }),
    )
    expect(r.cron_jobs.jobs![0]).toMatchObject({ job_name: 'nudge', last_run_status: 'ok' })
    // seconds → ms normalization (1_710_000_000s = March 2024, not 1970).
    expect(r.cron_jobs.jobs![0]!.last_run_at).toBe(1_710_000_000 * 1000)
    expect(new Date(r.cron_jobs.jobs![0]!.last_run_at!).getUTCFullYear()).toBe(2024)
    expect(r.import_jobs.jobs![0]).toMatchObject({ job_id: 'j1', status: 'failed', error_code: 'rate_limit' })
  })

  it('maps recent events', () => {
    const r = composeDiagnostics(
      baseSources({
        recentEvents: () => [{ ts: 5, level: 'error', module: 'gbrain', event: 'gbrain_unavailable', duration_ms: null }],
      }),
    )
    expect(r.recent_events.events![0]).toMatchObject({ ts: 5, level: 'error', event: 'gbrain_unavailable' })
  })

  it('fail-soft: a throwing source degrades ONLY its section', () => {
    const r = composeDiagnostics(
      baseSources({
        gbrain: () => {
          throw new Error('db closed')
        },
        credentials: () => ({ hasUsable: true, soonestCooldownUntil: null }),
      }),
    )
    expect(r.gbrain.available).toBe(false)
    expect(r.gbrain.note).toContain('source error: db closed')
    // Other sections unaffected.
    expect(r.credentials.available).toBe(true)
    expect(r.credentials.has_usable).toBe(true)
  })
})
