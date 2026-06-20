import { describe, expect, test } from 'bun:test'
import { emitTimerUnits } from './timer-emit.ts'

describe('emitTimerUnits', () => {
  test('renders a .timer + .service unit pair for an interval schedule', () => {
    const out = emitTimerUnits({
      job: {
        name: 'vault-backup',
        description: 'nightly backup',
        schedule: { kind: 'interval_ms', interval_ms: 24 * 60 * 60_000 },
        handler: 'vault_backup',
      },
      project_slug: 'acme',
      exec_start: '/usr/bin/bun /srv/neutron/cron/run-job.ts',
      user: 'neutron-acme',
    })
    expect(out.timer_unit_name).toBe('neutron-cron-vault-backup-acme.timer')
    expect(out.service_unit_name).toBe('neutron-cron-vault-backup-acme.service')
    expect(out.timer_contents).toContain('OnUnitActiveSec=86400s')
    expect(out.timer_contents).toContain(`Unit=${out.service_unit_name}`)
    expect(out.service_contents).toContain('Type=oneshot')
    expect(out.service_contents).toContain('User=neutron-acme')
    expect(out.service_contents).toContain('Environment=NEUTRON_CRON_JOB=vault-backup')
    // Canonical NEUTRON_INSTANCE_SLUG key.
    expect(out.service_contents).toContain('Environment=NEUTRON_INSTANCE_SLUG=acme')
  })

  test('renders an OnCalendar schedule verbatim', () => {
    const out = emitTimerUnits({
      job: {
        name: 'task-scan',
        description: '',
        schedule: { kind: 'oncalendar', expression: 'hourly' },
        handler: 'task_scan',
      },
      project_slug: 'acme',
      exec_start: '/usr/bin/bun /srv/neutron/cron/run-job.ts',
      user: 'neutron-acme',
    })
    expect(out.timer_contents).toContain('OnCalendar=hourly')
  })

  test('interval ms < 1s is clamped to 1s', () => {
    const out = emitTimerUnits({
      job: {
        name: 'fast',
        description: '',
        schedule: { kind: 'interval_ms', interval_ms: 50 },
        handler: 'fast',
      },
      project_slug: 'acme',
      exec_start: '/usr/bin/bun',
      user: 'neutron-acme',
    })
    expect(out.timer_contents).toContain('OnUnitActiveSec=1s')
  })
})
