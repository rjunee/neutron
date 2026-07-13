/**
 * @neutronai/open — `neutron doctor` diagnostics printer (unit O5).
 *
 * The GBrain doctor (`gbrain-memory/gbrain-doctor.ts`) answers "does memory
 * work?"; this printer extends `neutron doctor` to answer the rest of "why is
 * memory / chat / import broken?" from the CLI, WITHOUT journalctl. It opens
 * the per-instance `project.db` READ-ONLY (WAL lets it read alongside the live
 * server) and composes the on-disk diagnostic sections via the SAME pure
 * `composeDiagnostics` the admin endpoint uses. In-process-only sections
 * (credential-pool health, in-memory cores install failures) are not visible
 * off-process, so they render `{ available: false }` here — the running
 * instance's `GET /api/app/admin/diagnostics` (admin tab) has the full picture.
 *
 * READ-ONLY: opens the DB with `readonly: true` + `create: false` and only
 * reads. It never migrates, never writes.
 */

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeDiagnostics, type DiagnosticsReport } from '@neutronai/gateway/diagnostics/diagnostics-report.ts'
import { buildInstanceDiagnosticsSources } from '@neutronai/gateway/diagnostics/instance-sources.ts'
import { resolveNeutronHome, resolveOpenDbPath, resolveOwnerSlug } from './owner-identity.ts'
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

/** Build the report from the on-disk DB. Returns the report or an error note. */
export function collectCliDiagnostics(env: NodeJS.ProcessEnv = process.env):
  | { ok: true; report: DiagnosticsReport }
  | { ok: false; error: string } {
  const dbPath = resolveOpenDbPath(env)
  const owner_home = resolveNeutronHome(env)
  const project_slug = resolveOwnerSlug(env)

  let db: ProjectDb
  try {
    db = ProjectDb.open(dbPath, { create: false, readonly: true })
  } catch (err) {
    return {
      ok: false,
      error: `could not open project.db (read-only) at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  try {
    const report = composeDiagnostics(
      buildInstanceDiagnosticsSources({ db, project_slug, owner_home }),
    )
    return { ok: true, report }
  } finally {
    db.close()
  }
}

function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  return new Date(ms).toISOString()
}

/** Pure text formatter — testable without a DB. */
export function formatDiagnosticsText(report: DiagnosticsReport): string {
  const lines: string[] = []
  lines.push(`── diagnostics ─ instance=${report.project_slug} @ ${fmtTime(report.generated_at)} ──`)

  // memory
  const g = report.gbrain
  if (!g.available) {
    lines.push(`memory (gbrain): unavailable-to-read (${g.note ?? 'n/a'})`)
  } else if (g.status === undefined) {
    lines.push(`memory (gbrain): ${g.note ?? 'no sync state recorded'}`)
  } else {
    lines.push(
      `memory (gbrain): status=${g.status}` +
        (g.status === 'unavailable' ? ` LATCHED reason=${g.latch_reason ?? '?'} at=${g.latched_at ?? '?'}` : '') +
        ` last_success=${g.last_success_at ?? '—'} deferred=${g.deferred_count ?? 0}`,
    )
  }

  // credentials
  const c = report.credentials
  if (!c.available) {
    lines.push(`credentials: ${c.note ?? 'not readable off-process (see admin tab)'}`)
  } else {
    lines.push(
      `credentials: usable=${c.has_usable}` +
        (c.has_usable ? '' : ` soonest_cooldown=${fmtTime(c.soonest_cooldown_until)}`),
    )
  }

  // chat / REPL sessions
  const r = report.repl_sessions
  if (!r.available) {
    lines.push(`chat (REPL sessions): ${r.note ?? 'no registry'}`)
  } else if ((r.sessions?.length ?? 0) === 0) {
    lines.push(`chat (REPL sessions): none (${r.registry_path ?? '?'})`)
  } else {
    lines.push(`chat (REPL sessions): ${r.sessions!.length} (${r.registry_path ?? '?'})`)
    for (const s of r.sessions!) {
      lines.push(
        `  - ${s.key} model=${s.model ?? '?'} respawns=${s.respawn_count ?? 0}` +
          (s.capped_at ? ` CAPPED at=${fmtTime(s.capped_at)}` : '') +
          ` age=${s.age_ms === null || s.age_ms === undefined ? '—' : Math.round(s.age_ms / 1000) + 's'}`,
      )
    }
  }

  // cron
  const cj = report.cron_jobs
  if (!cj.available) {
    lines.push(`cron jobs: ${cj.note ?? 'no cron state'}`)
  } else if ((cj.jobs?.length ?? 0) === 0) {
    lines.push(`cron jobs: no runs recorded`)
  } else {
    lines.push(`cron jobs: ${cj.jobs!.length}`)
    for (const j of cj.jobs!) {
      lines.push(
        `  - ${j.job_name} last=${fmtTime(j.last_run_at)} status=${j.last_run_status ?? '—'}` +
          (j.last_run_error ? ` error=${j.last_run_error}` : ''),
      )
    }
  }

  // import
  const ij = report.import_jobs
  if (!ij.available) {
    lines.push(`import jobs: ${ij.note ?? 'no import jobs'}`)
  } else if ((ij.jobs?.length ?? 0) === 0) {
    lines.push(`import jobs: none`)
  } else {
    lines.push(`import jobs: ${ij.jobs!.length}`)
    for (const j of ij.jobs!) {
      lines.push(
        `  - ${j.job_id} source=${j.source ?? '?'} status=${j.status ?? '?'}` +
          (j.error_code ? ` error=[${j.error_code}] ${j.error_message ?? ''}` : ''),
      )
    }
  }

  // recent events — source is gateway_events (onboarding/gateway telemetry),
  // NOT the operational system_events journal (that table lands with unit O4).
  const ev = report.recent_events
  if (!ev.available) {
    lines.push(`recent events (gateway_events): ${ev.note ?? 'no events'}`)
  } else if ((ev.events?.length ?? 0) === 0) {
    lines.push(`recent events (gateway_events): none`)
  } else {
    lines.push(`recent events (gateway_events, newest first, ${ev.events!.length}):`)
    for (const e of ev.events!.slice(0, 15)) {
      lines.push(`  - ${fmtTime(e.ts)} [${e.level ?? '?'}] ${e.module ?? '?'}/${e.event ?? '?'}`)
    }
  }

  return lines.join('\n')
}

/** CLI entry — invoked by `bin/neutron doctor` after the GBrain checks. */
export function runDiagnosticsCli(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const wantJson = argv.includes('--json')
  const result = collectCliDiagnostics(env)
  if (!result.ok) {
    if (wantJson) {
      process.stdout.write(JSON.stringify({ ok: false, error: result.error }) + '\n')
    } else {
      process.stdout.write(`\n── diagnostics ──\n${result.error}\n`)
    }
    // A missing/unreadable DB is not a doctor failure (fresh box, server not yet
    // booted) — print the note and exit 0 so `neutron doctor` stays green.
    return 0
  }
  if (wantJson) {
    process.stdout.write(JSON.stringify({ ok: true, diagnostics: result.report }) + '\n')
  } else {
    process.stdout.write('\n' + formatDiagnosticsText(result.report) + '\n')
  }
  return 0
}

if (import.meta.main) {
  installProcessSafetyNet() // F3 — standalone CLI entrypoint
  process.exit(runDiagnosticsCli(process.argv.slice(2)))
}
