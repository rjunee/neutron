/**
 * O5 — `neutron doctor` diagnostics CLI tests.
 *
 *  - `collectCliDiagnostics` opens a REAL migrated `project.db` read-only and
 *    composes every DB-backed section (empty DB → sections available with empty
 *    payloads; credentials unavailable off-process),
 *  - a missing DB returns `{ ok: false }` (a fresh box is NOT a doctor failure),
 *  - `formatDiagnosticsText` renders a human summary of a synthetic report.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrationsToProjectDb } from '@neutronai/migrations/runner.ts'
import { composeDiagnostics } from '@neutronai/gateway/diagnostics/diagnostics-report.ts'
import { collectCliDiagnostics, formatDiagnosticsText, fmtPayload } from '../diagnostics-cli-impl.ts'

let tmp: string

function envFor(dbPath: string): NodeJS.ProcessEnv {
  return {
    NEUTRON_DB_PATH: dbPath,
    NEUTRON_HOME: tmp,
    NEUTRON_INSTANCE_SLUG: 'demo',
  } as NodeJS.ProcessEnv
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'o5-cli-'))
})
afterEach(() => {
  if (typeof tmp === 'string' && tmp.length > 0) rmSync(tmp, { recursive: true, force: true })
})

describe('collectCliDiagnostics', () => {
  it('reads a real migrated project.db read-only and composes DB-backed sections', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const r = result.report
    expect(r.project_slug).toBe('demo')
    // DB-backed sections are readable (tables exist, no rows yet).
    expect(r.cron_jobs.available).toBe(true)
    expect(r.cron_jobs.jobs).toEqual([])
    expect(r.import_jobs.available).toBe(true)
    expect(r.import_jobs.jobs).toEqual([])
    expect(r.recent_events.available).toBe(true)
    // gbrain row absent → available with a "no state yet" note.
    expect(r.gbrain.available).toBe(true)
    expect(r.gbrain.status).toBeUndefined()
    // repl registry file absent under owner_home → available, empty.
    expect(r.repl_sessions.available).toBe(true)
    expect(r.repl_sessions.sessions).toEqual([])
    // credentials are in-process-only → not available off-process.
    expect(r.credentials.available).toBe(false)
  })

  it('surfaces a gbrain latch + import job written to the DB', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.runSync(
      `INSERT INTO gbrain_sync_state (scope, status, latch_reason, latched_at, last_success_at, deferred_count, updated_at)
       VALUES (?, 'unavailable', 'GBrainUnavailableError', '2026-07-01T00:00:00Z', NULL, 3, '2026-07-01T00:00:01Z')`,
      ['demo'],
    )
    db.runSync(
      `INSERT INTO import_jobs (job_id, project_slug, source, status, started_at, error_code, error_message)
       VALUES ('j1', 'demo', 'chatgpt-zip', 'failed', 100, 'rate_limit', 'slow down')`,
      [],
    )
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.gbrain.status).toBe('unavailable')
    expect(result.report.gbrain.deferred_count).toBe(3)
    expect(result.report.import_jobs.jobs?.[0]).toMatchObject({ job_id: 'j1', status: 'failed', error_code: 'rate_limit' })
  })

  it('surfaces a system_events degrade row (O4 journal) off-process', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    // A `core_install_failed` degrade — the exact "why is a Core broken?" signal
    // the journal makes visible without journalctl.
    db.runSync(
      `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
       VALUES ('e1', 500, 'error', 'cores', 'core_install_failed', ?, 'demo', NULL)`,
      [JSON.stringify({ core_slug: 'email', code: 'manifest_invalid' })],
    )
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ev = result.report.recent_events
    expect(ev.available).toBe(true)
    expect(ev.events?.[0]).toMatchObject({
      ts: 500,
      level: 'error',
      module: 'cores',
      event: 'core_install_failed',
      project_slug: 'demo',
      payload: { core_slug: 'email', code: 'manifest_invalid' },
    })
    // the printer labels the section as the operational system_events journal AND
    // renders the structured payload (which core failed + why) — the whole point
    // of the journal: answerable without journalctl.
    const text = formatDiagnosticsText(result.report)
    expect(text).toContain('recent events (system_events')
    expect(text).toContain('cores/core_install_failed')
    expect(text).toContain('core_slug=email')
    expect(text).toContain('code=manifest_invalid')
  })

  describe('fmtPayload — terminal-injection safety + caps', () => {
    it('strips newlines and ANSI/control sequences (no forged lines, one line out)', () => {
      // A journal payload carries attacker-influenceable error text.
      const out = fmtPayload({ message: 'failed\ncredentials: usable=true\u001b[2Jx\r\t' })
      expect(out).not.toContain('\n')
      expect(out).not.toContain('\r')
      expect(out).not.toContain('\u001b') // ESC — no clear-screen etc.
      expect(out).not.toContain('\t')
      // The visible text survives (controls → spaces), so it's still informative.
      expect(out).toContain('message=failed')
    })

    it('caps a long value at 80 and the whole line at 200 chars (…-elided)', () => {
      const longVal = 'x'.repeat(500)
      const perValue = fmtPayload({ k: longVal })
      expect(perValue.length).toBeLessThanOrEqual(2 + 80) // "k=" + 80
      expect(perValue.endsWith('…')).toBe(true)
      const wide = fmtPayload(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'v'.repeat(30)])))
      expect(wide.length).toBeLessThanOrEqual(200)
      expect(wide.endsWith('…')).toBe(true)
    })

    it('non-object / empty payloads render as empty', () => {
      expect(fmtPayload(null)).toBe('')
      expect(fmtPayload('a string')).toBe('')
      expect(fmtPayload({})).toBe('')
    })

    it('is fail-soft on undefined / BigInt / circular values (never throws)', () => {
      // Journal payloads are JSON-parsed so these shouldn't occur, but fmtPayload
      // takes `unknown` + is a diagnostics render — it must never crash.
      expect(() => fmtPayload({ x: undefined })).not.toThrow()
      expect(fmtPayload({ x: undefined })).toContain('x=undefined')
      expect(() => fmtPayload({ x: 1n })).not.toThrow()
      expect(fmtPayload({ x: 1n })).toContain('x=1')
      const circular: Record<string, unknown> = {}
      circular['self'] = circular
      expect(() => fmtPayload(circular)).not.toThrow()
      expect(fmtPayload(circular)).toContain('self=')
      // A null-prototype object still renders (no inherited toString needed).
      expect(fmtPayload(Object.assign(Object.create(null), { code: 'x' }))).toContain('code=x')
    })

    it('degrades to a marker (never throws) when even Object.entries throws — a hostile proxy', () => {
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('nope')
          },
        },
      )
      expect(() => fmtPayload(hostile)).not.toThrow()
      expect(fmtPayload(hostile)).toBe('[unrenderable payload]')
    })
  })

  it('scopes cron jobs to THIS instance slug (no cross-project leak)', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.runSync(
      `INSERT INTO cron_state (job_name, project_slug, last_run_at, last_run_status, last_run_error, last_run_duration_ms)
       VALUES ('nudge', 'demo', 1710000000, 'ok', NULL, 5)`,
      [],
    )
    db.runSync(
      `INSERT INTO cron_state (job_name, project_slug, last_run_at, last_run_status, last_run_error, last_run_duration_ms)
       VALUES ('secret-job', 'other-project', 20, 'error', 'private error text', 9)`,
      [],
    )
    db.close()

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const jobs = result.report.cron_jobs.jobs ?? []
    expect(jobs.map((j) => j.job_name)).toEqual(['nudge'])
    // the other project's error text must NOT be present
    expect(JSON.stringify(jobs)).not.toContain('private error text')
    // last_run_at (Unix seconds in cron_state) is normalized to epoch-MS end-to-end:
    // 1_710_000_000s → March 2024, NOT Jan 1970.
    expect(jobs[0]!.last_run_at).toBe(1_710_000_000 * 1000)
    expect(new Date(jobs[0]!.last_run_at!).getUTCFullYear()).toBe(2024)
  })

  it('repl registry: absent file → available with zero sessions', () => {
    const dbPath = join(tmp, 'project.db')
    ProjectDb.open(dbPath).close()
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()
    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.repl_sessions.available).toBe(true)
    expect(result.report.repl_sessions.sessions).toEqual([])
  })

  it('repl registry: corrupt file → available:false with a note (NOT falsely healthy)', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()
    // owner_home is `tmp` (see envFor) → registry at tmp/.neutron/repl-registry.json
    mkdirSync(join(tmp, '.neutron'), { recursive: true })
    writeFileSync(join(tmp, '.neutron', 'repl-registry.json'), '{ this is not valid json', 'utf8')

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.repl_sessions.available).toBe(false)
    expect(result.report.repl_sessions.note).toContain('repl-registry unreadable/corrupt')
    // must NOT report a healthy "no sessions" state
    expect(result.report.repl_sessions.sessions).toBeUndefined()
  })

  it('returns { ok: false } when project.db does not exist (fresh box)', () => {
    const result = collectCliDiagnostics(envFor(join(tmp, 'missing.db')))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('could not open project.db')
  })

  /**
   * THE DIAGNOSTIC MUST SURVIVE THE BROKEN CONFIGURATION IT EXISTS TO REPORT.
   *
   * A round of this branch made `resolveOwnerSlug` delegate to the full
   * `resolveBootConfig` so it could no longer disagree with boot about
   * `.url_slug` or the default home. Correct about the inputs — and it inherited
   * the validation of every unrelated numeric knob. `diagnostics-cli-impl.ts:32`
   * calls the resolver OUTSIDE the try that produces `{ok:false}`, so a single
   * bad `NEUTRON_PORT` made `neutron doctor` throw a ZodError at the operator
   * instead of printing the state of their box.
   *
   * Reproduced before the fix: `NEUTRON_PORT=bad` → `ZodError: NEUTRON_PORT="bad"
   * is not an integer`.
   */
  it('does NOT throw when an UNRELATED setting is malformed', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()

    // CONTROL — the same env without the bad knob works, so a pass below cannot
    // come from the fixture being broken in some other way.
    const clean = collectCliDiagnostics(envFor(dbPath))
    expect(clean.ok).toBe(true)

    const env = { ...envFor(dbPath), NEUTRON_PORT: 'bad' } as NodeJS.ProcessEnv
    const result = collectCliDiagnostics(env)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // …and the identity is still the RIGHT one. A `doctor` that survived by
    // resolving the wrong slug would report an empty instance, which is the
    // failure mode the slug work on this branch exists to close.
    expect(result.report.project_slug).toBe('demo')
  })

  /**
   * THE SAME CONTRACT, THE OTHER WAY OUT OF THE SAME LINE.
   *
   * The round above closed the ZodError escape and left a filesystem one open
   * on the very next statement: the resolver does an UNGUARDED
   * `readFileSync(join(ownerHome, '.url_slug'))` behind an `existsSync` check.
   * `existsSync` is true for a chmod-000 file and for a DIRECTORY of that name,
   * and the read then throws EACCES / EISDIR — past the same `{ok:false}`
   * contract, from the same call site (`diagnostics-cli-impl.ts`, outside the
   * try). EACCES on `.url_slug` is a recorded real failure mode, not a
   * hypothetical.
   *
   * The guard above cannot see this: it varies only `NEUTRON_PORT`, so it stays
   * green while the filesystem axis throws. Both variants were reproduced
   * against the unfixed resolver — `EACCES: permission denied, open
   * '<home>/.url_slug'` and `EISDIR: illegal operation on a directory, read`.
   *
   * ⚠️ THE CONTRACT IS `{ok:false}`, NOT `{ok:true}` WITH A SUBSTITUTED SLUG.
   * The first fix made the resolver swallow the read error and answer with
   * `NEUTRON_INSTANCE_SLUG`, and these tests asserted `ok:true` — which pinned
   * a doctor that reports an identity it could not actually confirm, and, far
   * worse, handed the same fabricated `source:'env'` to the credential
   * direction guard, which then migrated rows onto the stale handle. The slug
   * filters every event and job in this report, so answering with the wrong one
   * renders a healthy instance empty. `{ok:false}` carrying the errno is the
   * honest answer, is what `main` returns, and is what the printed contract
   * says. Not throwing was always the requirement; `ok:true` never was.
   */
  it('returns {ok:false} — not a throw — when `.url_slug` cannot be read (EACCES)', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()

    const slugFile = join(tmp, '.url_slug')
    writeFileSync(slugFile, 'renamed\n', 'utf8')
    // CONTROL — readable, the file WINS over the env slug. Without this a pass
    // below could mean the resolver never looks at `.url_slug` at all.
    const readable = collectCliDiagnostics(envFor(dbPath))
    expect(readable.ok).toBe(true)
    if (!readable.ok) return
    expect(readable.report.project_slug).toBe('renamed')

    chmodSync(slugFile, 0o000)
    // `chmod 000` is advisory against root. The previous version of this test
    // bailed with a bare `return` when the mode did not bite, so a test NAMED
    // for the EACCES axis passed green on a root runner having asserted
    // nothing. Assert the correct outcome for whichever world we are in
    // instead: root still reads the file, and then the file must WIN.
    let denied = false
    try {
      readFileSync(slugFile, 'utf8')
    } catch {
      denied = true
    }
    if (!denied) {
      const asRoot = collectCliDiagnostics(envFor(dbPath))
      expect(asRoot.ok).toBe(true)
      if (!asRoot.ok) return
      expect(asRoot.report.project_slug).toBe('renamed')
      return
    }

    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(false)
    if (result.ok) return
    // The operator's next action is a `chmod`, so the error has to name the
    // file and the reason — not just "something went wrong".
    expect(result.error).toContain('.url_slug')
    expect(result.error).toContain('identity')
    // And it must NOT be the stale env handle wearing the costume of an answer.
    expect(result.error).not.toContain('project_slug=demo')
  })

  it('returns {ok:false} — not a throw — when `.url_slug` is a directory (EISDIR)', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()

    // CONTROL — the same env with no `.url_slug` at all already returns ok.
    // A directory denies root as well, so this case runs everywhere.
    const before = collectCliDiagnostics(envFor(dbPath))
    expect(before.ok).toBe(true)

    mkdirSync(join(tmp, '.url_slug'))
    const result = collectCliDiagnostics(envFor(dbPath))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('.url_slug')
  })

  /**
   * AN EMPTY `OWNER_HOME` MUST NOT BLIND THE DIAGNOSTIC EITHER.
   *
   * `neutron doctor` filters events and jobs by the slug it resolves, so a
   * resolver that collapses to `'dev'` reports an empty instance for a system
   * running perfectly well — the exact failure this file's other cases exist to
   * prevent, reached through a different input.
   */
  it('reads `.url_slug` under NEUTRON_HOME when OWNER_HOME is the empty string', () => {
    const dbPath = join(tmp, 'project.db')
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.close()
    writeFileSync(join(tmp, '.url_slug'), 'renamed\n', 'utf8')

    const env = { ...envFor(dbPath), OWNER_HOME: '' } as NodeJS.ProcessEnv
    const result = collectCliDiagnostics(env)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.project_slug).toBe('renamed')
  })
})

/**
 * THE DOCTOR MUST READ THE SCOPE BOOT WROTE UNDER (Argus r2, 2026-08-16).
 * `system_events` is read strictly `WHERE project_slug = ?`, so any disagreement
 * between `resolveOwnerSlug` here and `resolveOwnerSlugSourceFromConfig` at boot
 * is a silently empty report — on exactly the degrade events whose defect was
 * being unreadable in the first place.
 */
describe('collectCliDiagnostics — the CLI scope agrees with the boot scope', () => {
  function seedRefusalUnder(dbPath: string, scope: string): void {
    const db = ProjectDb.open(dbPath)
    applyMigrationsToProjectDb(db)
    db.runSync(
      `INSERT INTO system_events (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
       VALUES ('r1', 700, 'warn', 'gateway', 'instance_scope_rekey_refused', ?, ?, NULL)`,
      [JSON.stringify({ stranded_slug: scope, attempted_by_slug: 'dev' }), scope],
    )
    db.close()
  }

  it('TRIMS a padded NEUTRON_INSTANCE_SLUG, as boot does', () => {
    const dbPath = join(tmp, 'project.db')
    seedRefusalUnder(dbPath, 'alpha')
    const result = collectCliDiagnostics({
      NEUTRON_DB_PATH: dbPath,
      NEUTRON_HOME: tmp,
      NEUTRON_INSTANCE_SLUG: '  alpha  ',
    } as NodeJS.ProcessEnv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.project_slug).toBe('alpha')
    expect(result.report.recent_events.events?.[0]).toMatchObject({
      event: 'instance_scope_rekey_refused',
      project_slug: 'alpha',
    })
  })

  it('a blank NEUTRON_INSTANCE_SLUG means ABSENT → the same fallback boot uses', () => {
    const dbPath = join(tmp, 'project.db')
    seedRefusalUnder(dbPath, 'dev')
    const result = collectCliDiagnostics({
      NEUTRON_DB_PATH: dbPath,
      NEUTRON_HOME: tmp,
      NEUTRON_INSTANCE_SLUG: '   ',
    } as NodeJS.ProcessEnv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.project_slug).toBe('dev')
    expect(result.report.recent_events.events).toHaveLength(1)
  })

  it('the .url_slug rename file WINS over the env var, as it does at boot', () => {
    // The rename orchestrator writes this file and restarts the unit; boot has
    // always preferred it. A doctor that ignored it reported under the
    // PRE-rename handle — i.e. found nothing on every renamed box.
    const dbPath = join(tmp, 'project.db')
    seedRefusalUnder(dbPath, 'renamed')
    writeFileSync(join(tmp, '.url_slug'), 'renamed\n')
    const result = collectCliDiagnostics({
      NEUTRON_DB_PATH: dbPath,
      NEUTRON_HOME: tmp,
      NEUTRON_INSTANCE_SLUG: 'old-handle',
    } as NodeJS.ProcessEnv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.project_slug).toBe('renamed')
    expect(result.report.recent_events.events).toHaveLength(1)
    // CONTROL — the pre-rename handle really is a different, empty scope, so
    // the assertion above is about the resolver and not about a lax reader.
    const stale = collectCliDiagnostics({
      NEUTRON_DB_PATH: dbPath,
      NEUTRON_HOME: mkdtempSync(join(tmpdir(), 'o5-cli-nofile-')),
      NEUTRON_INSTANCE_SLUG: 'old-handle',
    } as NodeJS.ProcessEnv)
    expect(stale.ok).toBe(true)
    if (!stale.ok) return
    expect(stale.report.project_slug).toBe('old-handle')
    expect(stale.report.recent_events.events).toEqual([])
  })
})

describe('formatDiagnosticsText', () => {
  it('renders a readable multi-section summary', () => {
    const report = composeDiagnostics({
      project_slug: 'demo',
      now: () => 0,
      gbrain: () => ({
        status: 'unavailable',
        latchReason: 'GBrainUnavailableError',
        latchedAt: '2026-07-01T00:00:00Z',
        lastSuccessAt: null,
        deferredCount: 3,
        updatedAt: '2026-07-01T00:00:01Z',
      }),
      importJobs: () => [
        { job_id: 'j1', source: 'chatgpt', status: 'failed', started_at: 1, completed_at: 2, error_code: 'rate_limit', error_message: 'x' },
      ],
    })
    const text = formatDiagnosticsText(report)
    expect(text).toContain('instance=demo')
    expect(text).toContain('memory (gbrain): status=unavailable')
    expect(text).toContain('LATCHED reason=GBrainUnavailableError')
    expect(text).toContain('import jobs: 1')
    expect(text).toContain('j1')
    // in-process-only sections are labelled, not crashed
    expect(text).toContain('credentials:')
  })
})
