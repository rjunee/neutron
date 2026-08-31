/**
 * Pins the per-instance env scrub (`scrub-instance-env.ts`) — the preload that
 * stops `bun test` inheriting a live instance's data home and identity config.
 *
 * WHY A CHILD PROCESS: bun runs test FILES concurrently inside ONE process and
 * `process.env` is process-global, so asserting `process.env.NEUTRON_DB_PATH
 * === undefined` inline would race any neighbouring file's
 * `createIsolatedHome`. The probe (`scrub-instance-env-probe.ts`, deliberately
 * not named `*.test.*`) runs the scrub in its own process against a
 * deliberately POISONED env, which makes the assertion deterministic on every
 * box — including CI, whose outer environment is already clean and could
 * therefore never demonstrate the scrub at all.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '..', '..')

describe('scrub-instance-env preload', () => {
  test('the preload neutralizes a poisoned live-instance env', () => {
    const probe = join(import.meta.dir, 'scrub-instance-env-probe.ts')
    // `bun run <file>` — NOT `bun test`, whose explicit-path discovery of a
    // non-`.test.*` file is not guaranteed.
    const result = Bun.spawnSync({
      cmd: [process.execPath, 'run', probe],
      cwd: repoRoot,
      env: {
        ...process.env,
        NEUTRON_DB_PATH: '/nonexistent/poison/project.db',
        OWNER_HOME: '/nonexistent/poison',
        NEUTRON_INSTANCE_SLUG: 'poison',
        NEUTRON_IDENTITY_JWKS_URL: 'https://poison.invalid/jwks.json',
        NEUTRON_TEST_SHARD: 'sentinel-1/1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    // Surface the probe's own message — it names the variable that survived.
    if (result.exitCode !== 0) {
      throw new Error(`scrub probe exited ${String(result.exitCode)}:\n${stderr}`)
    }
    expect(stdout).toContain('SCRUB_OK')
  })

  test('the preload is registered', () => {
    const bunfig = readFileSync(join(repoRoot, 'bunfig.toml'), 'utf8')
    const preload = /^preload\s*=\s*\[(.*)\]/m.exec(bunfig)
    expect(preload).not.toBeNull()
    const entries = (preload?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    // Test A exercises the module directly; this pins that `bun test` actually
    // loads it — and that it does not displace the substrate-credential scrub.
    expect(entries).toContain('./tests/support/scrub-substrate-env.ts')
    expect(entries).toContain('./tests/support/scrub-instance-env.ts')
  })
})
