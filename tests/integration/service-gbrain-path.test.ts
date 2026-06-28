/**
 * neutron-service.sh — the generated launchd plist / systemd unit must put the
 * bun GLOBAL-BIN dir (`$BUN_INSTALL/bin`, default `$HOME/.bun/bin`) on the
 * service PATH, so the running server can resolve the `gbrain` binary
 * `bun install -g` lands there. Without it the SERVICE (which gets a narrow
 * curated PATH, unlike the install script's own shell) can't find gbrain →
 * entity-page memory is silently DISABLED on every install (dogfood 2026-06-28).
 *
 * Driven through the `print` subcommand (`do_print` → `generate_plist` /
 * `generate_unit`), which emits the unit to stdout — no fake launchd/systemd and
 * no file writes needed. The NEUTRON_SERVICE_OS seam selects the target.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE_SH = join(HERE, '..', '..', 'neutron-service.sh')

function renderUnit(os: 'darwin' | 'linux', env: Record<string, string>): string {
  const res = spawnSync('sh', [SERVICE_SH, 'print'], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      NEUTRON_SERVICE_OS: os,
      // Embedded in the unit only (never executed by `print`), so any path works.
      BUN_BIN: '/bin/echo',
      ...env,
    },
  })
  expect(res.status).toBe(0)
  return res.stdout ?? ''
}

/** Pull the PATH string out of a rendered plist or systemd unit. */
function extractPath(unit: string, os: 'darwin' | 'linux'): string {
  if (os === 'linux') {
    const m = unit.match(/Environment=PATH=(.*)/)
    return m?.[1]?.trim() ?? ''
  }
  // plist: <key>PATH</key>\n\t\t\t<string>...</string>
  const m = unit.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)
  return m?.[1] ?? ''
}

describe('neutron-service.sh — service PATH includes the bun global-bin dir', () => {
  test('launchd plist PATH contains $BUN_INSTALL/bin (honoring BUN_INSTALL)', () => {
    const home = '/home/tester'
    const bunInstall = '/opt/bun'
    const unit = renderUnit('darwin', { HOME: home, BUN_INSTALL: bunInstall })
    const path = extractPath(unit, 'darwin')
    expect(path.split(':')).toContain('/opt/bun/bin')
  })

  test('defaults the bun global-bin dir to $HOME/.bun/bin when BUN_INSTALL unset', () => {
    const home = '/home/tester'
    const unit = renderUnit('darwin', { HOME: home })
    const path = extractPath(unit, 'darwin')
    expect(path.split(':')).toContain('/home/tester/.bun/bin')
  })

  test('systemd unit PATH also carries the bun global-bin dir', () => {
    const home = '/home/tester'
    const unit = renderUnit('linux', {
      HOME: home,
      // systemd unit lands under XDG; isolate it but we only read stdout.
      XDG_CONFIG_HOME: join(home, '.config'),
    })
    const path = extractPath(unit, 'linux')
    expect(path.split(':')).toContain('/home/tester/.bun/bin')
  })

  test('no duplicate entry when the bun BINARY dir equals the global-bin dir', () => {
    // BUN_BIN under $HOME/.bun/bin makes #3 (global-bin) and #4 (binary dir)
    // collide — the dedup must keep exactly one.
    const home = '/home/tester'
    const unit = renderUnit('darwin', { HOME: home, BUN_BIN: '/home/tester/.bun/bin/bun' })
    const entries = extractPath(unit, 'darwin').split(':')
    expect(entries.filter((d) => d === '/home/tester/.bun/bin')).toHaveLength(1)
  })
})
