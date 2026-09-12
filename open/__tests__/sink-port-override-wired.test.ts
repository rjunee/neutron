/**
 * ISSUES #537 — the reply sink's port override reaches the sink FROM THE RESOLVED
 * BOOT CONFIG, through the real Open composer.
 *
 * WHY THIS FILE EXISTS. `resolveBootConfig()` is this tree's single env resolution;
 * it validates `NEUTRON_REPL_SINK_PORT` and keeps it as `BootConfig.replSinkPort`.
 * For two rounds nothing consumed that field: the sink re-read the raw environment
 * for itself, so an INJECTED config was inert — resolve a config carrying
 * `NEUTRON_REPL_SINK_PORT=23456`, boot from it with the process variable cleared,
 * and the sink derived a different port. Reviewed and reproduced. A unit test of
 * `setReplSinkPortOverride` cannot catch that class: the defect was that nobody
 * CALLED it, which is exactly the "wired but not served does not count" shape.
 *
 * WHY EACH CASE IS A SUBPROCESS. The wired override is PROCESS-GLOBAL, and a dozen
 * other files in this directory boot the same composer — every one of them wiring
 * `undefined` because they pass no such knob. `bun test` runs files concurrently
 * inside one process, so an in-process version of this test asserts a global that a
 * neighbouring file can clear between the compose and the assertion. It did: one
 * local run out of four went red with no other explanation, and the same shape (a
 * test reaching for state it does not own) had already produced two CI failures in
 * this PR. So each case boots its own process, where the only composer is the one
 * under test.
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const LANDING_DIR = join(REPO, 'landing')

const MODULES = {
  seed: join(REPO, 'tests', 'support', 'migrated-db.ts'),
  db: join(REPO, 'persistence', 'index.ts'),
  config: join(REPO, 'config', 'index.ts'),
  composer: join(HERE, '..', 'composer.ts'),
  sink: join(REPO, 'runtime', 'adapters', 'claude-code', 'persistent', 'sink-coordinates.ts'),
} as const

interface ComposeResult {
  resolved: number
  derived: number
}

/**
 * Boot the REAL composer in a fresh process with `extraEnv` folded into the config
 * it resolves, then ask the runtime which port the sink would bind.
 *
 * `NEUTRON_REPL_SINK_PORT` is deliberately absent from the child's ENVIRONMENT in
 * every case: when the knob is under test it travels only inside the resolved
 * `BootConfig`, which is the whole point — that is the path a second read of
 * `process.env` made inert.
 */
async function composeInChild(extraEnv: Record<string, string>): Promise<ComposeResult> {
  const home = mkdtempSync(join(tmpdir(), 'neutron-sink-port-wired-'))
  try {
    const dbPath = join(home, 'project.db')
    const stateDir = join(home, '.neutron')
    const code = `
      const { seedMigratedDb } = await import(${JSON.stringify(MODULES.seed)})
      const { ProjectDb } = await import(${JSON.stringify(MODULES.db)})
      const { resolveBootConfig } = await import(${JSON.stringify(MODULES.config)})
      const { buildOpenGraphComposer } = await import(${JSON.stringify(MODULES.composer)})
      const { resolveSinkPort, deriveSinkPort } = await import(${JSON.stringify(MODULES.sink)})
      seedMigratedDb(${JSON.stringify(dbPath)})
      const db = ProjectDb.open(${JSON.stringify(dbPath)})
      const config = resolveBootConfig({ ...process.env, ...${JSON.stringify(extraEnv)} })
      const composer = buildOpenGraphComposer({
        env: process.env,
        substrateFactory: () => ({ start: () => { throw new Error('substrate unused in this test') } }),
        config,
      })
      await composer({ db, project_slug: 'owner' })
      process.stdout.write('RESULT:' + JSON.stringify({
        resolved: resolveSinkPort({ stateDir: ${JSON.stringify(stateDir)} }),
        derived: deriveSinkPort(${JSON.stringify(stateDir)}),
      }) + '\\n')
      process.exit(0)
    `
    const child = Bun.spawn([process.execPath, '-e', code], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        NEUTRON_HOME: home,
        OWNER_HOME: home,
        NEUTRON_DB_PATH: dbPath,
        NEUTRON_INSTANCE_SLUG: 'owner',
        NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
        NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
        ANTHROPIC_API_KEY: 'sk-ant-test-sink-port-wired',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        NOTIFY_SOCKET: undefined,
        // The environment NEVER carries the knob: only the resolved config can.
        NEUTRON_REPL_SINK_PORT: undefined,
      },
    })
    const stdout = child.stdout
    const stderr = child.stderr
    if (!(stdout instanceof ReadableStream) || !(stderr instanceof ReadableStream)) {
      throw new Error('child streams are not piped')
    }
    const out = await new Response(stdout).text()
    const err = await new Response(stderr).text()
    await child.exited
    const line = out.split('\n').find((l) => l.startsWith('RESULT:'))
    if (line === undefined) {
      throw new Error(`composer child produced no RESULT (exit=${child.exitCode})\n${out}\n${err}`)
    }
    return JSON.parse(line.slice('RESULT:'.length)) as ComposeResult
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('a config-carried NEUTRON_REPL_SINK_PORT reaches the sink, with the process variable cleared', async () => {
  const result = await composeInChild({ NEUTRON_REPL_SINK_PORT: '23456' })

  // The operator's knob — which existed ONLY inside the injected config — is what
  // the sink would bind. This assertion was false for two rounds while
  // `resolveBootConfig` parsed the value and nothing consumed it.
  expect(result.resolved).toBe(23456)
  expect(result.resolved).not.toBe(result.derived)
}, 60_000)

test('a config WITHOUT the knob leaves the per-instance derivation in place', async () => {
  // The paired case, without which the one above is untested in the direction that
  // matters: wiring must not latch a value for the process. A composer that always
  // set an override — or set a constant — would pass the first test and break every
  // instance that never sets the knob.
  const result = await composeInChild({})

  expect(result.resolved).toBe(result.derived)
}, 60_000)
