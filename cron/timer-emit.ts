/**
 * @neutronai/cron — systemd timer emission.
 *
 * Replaces Nova's
 * internal design notes (which emits launchd plists). For each
 * `CronJobDef` we emit a `.timer` + matching `.service` unit that systemd
 * picks up via `systemctl --user daemon-reload`.
 *
 * The emitter is pure-functional: takes a job + instance info, returns the
 * unit-file contents. Disk write + daemon-reload happens in the install
 * pipeline (`scripts/install/`); this module just renders.
 *
 * launchd → systemd timer mapping (per the plan):
 *   - `RunAtLoad: true` → systemd persistence is implicit
 *   - `KeepAlive: true` → `Restart=always` on the .service
 *   - `WatchPaths` → out of scope here (a separate `.path` unit type)
 */

import type { CronJobDef, CronSchedule } from './jobs.ts'

export interface EmitInput {
  job: CronJobDef
  owner_slug: string
  /** Absolute path the .service ExecStart points at (the gateway entry). */
  exec_start: string
  /** Per-instance Unix user the service runs as. */
  user: string
}

export interface EmittedUnits {
  timer_unit_name: string
  service_unit_name: string
  timer_contents: string
  service_contents: string
}

export function emitTimerUnits(input: EmitInput): EmittedUnits {
  const { job, owner_slug } = input
  const safeName = `${job.name}-${owner_slug}`
  const timer_unit_name = `neutron-cron-${safeName}.timer`
  const service_unit_name = `neutron-cron-${safeName}.service`
  const timer_contents = renderTimer(job, service_unit_name)
  const service_contents = renderService(job, input)
  return { timer_unit_name, service_unit_name, timer_contents, service_contents }
}

function renderTimer(job: CronJobDef, service_unit_name: string): string {
  const lines: string[] = [
    '[Unit]',
    `Description=Neutron cron timer: ${job.name}`,
    '',
    '[Timer]',
    `Unit=${service_unit_name}`,
    ...renderScheduleLines(job.schedule),
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ]
  return lines.join('\n')
}

function renderService(job: CronJobDef, input: EmitInput): string {
  const lines: string[] = [
    '[Unit]',
    `Description=Neutron cron job: ${job.name} (${job.description})`,
    '',
    '[Service]',
    'Type=oneshot',
    `User=${input.user}`,
    `Environment=NEUTRON_CRON_JOB=${job.name}`,
    `Environment=NEUTRON_INSTANCE_SLUG=${input.owner_slug}`,
    `ExecStart=${input.exec_start}`,
    'StandardOutput=journal',
    'StandardError=journal',
    '',
  ]
  return lines.join('\n')
}

function renderScheduleLines(schedule: CronSchedule): string[] {
  if (schedule.kind === 'oncalendar') {
    return [`OnCalendar=${schedule.expression}`]
  }
  // interval — convert ms to a systemd OnUnitActiveSec spec
  // Use seconds; systemd accepts integer seconds with no unit
  const seconds = Math.max(1, Math.round(schedule.interval_ms / 1000))
  return [`OnBootSec=${seconds}s`, `OnUnitActiveSec=${seconds}s`]
}
