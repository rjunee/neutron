// F3 (Medium #3) — every PRODUCTION standalone entrypoint must arm the
// process-level rejection/exception safety net as its FIRST statement, so an
// EARLY startup failure is logged-then-crashed (structured `[process] event=…`)
// instead of a bare runtime error. These are BEHAVIORAL subprocess tests: spawn
// the real entrypoint, trigger a failure, and assert (a) nonzero exit and (b)
// the structured log — proving the net is armed BEFORE the failure point.
//
// STANDALONE-ENTRYPOINT INVENTORY (systematic sweep: `import.meta.main`,
// top-level `await`, and `bun <script.ts>` spawns):
//   - gateway/index.ts        → installs it inside boot()
//   - open/server.ts          → hoisted install (before startOpenServer) [tested]
//   - landing/boot.ts         → install first in the import.meta.main block
//   - runtime/.../dev-channel.ts   → spawned MCP process; install first [tested]
//   - runtime/.../tools-bridge.ts  → spawned MCP process; install first [tested]
//   - gbrain-memory/gbrain-doctor.ts    → CLI; install first in the main block
//   - open/diagnostics-cli.ts           → CLI; install first in the main block
//   - migrations/runner.ts              → CLI; install first [tested]
//   NOT in-repo: the trident launcher (external `claude -p`) + the Managed
//   launcher (separate repo). Skipped: CI tooling (depcruise-ratchet-compare).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const abs = (rel: string): string => join(REPO, rel)
const STRUCTURED = /\[process\] event=(uncaught_exception|unhandled_rejection)/

/** Env with NODE_ENV removed (so the net's crash policy is NOT suppressed). */
function crashEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['NODE_ENV']
  return { ...env, ...extra }
}

/**
 * Spawn a top-level-script entrypoint that does NOT self-crash via env, then —
 * once its module top-level has run (arming the net) — inject an unhandled
 * throw. stdin is kept OPEN so the MCP scripts don't graceful-shutdown on EOF
 * before the injected failure fires. Proves the entrypoint INSTALLS the net.
 */
async function importThenInject(entryAbs: string): Promise<{ code: number; out: string }> {
  const harness = `await import(${JSON.stringify(entryAbs)}); setTimeout(() => { throw new Error('probe-injected') }, 250)`
  const proc = Bun.spawn(['bun', '-e', harness], {
    env: crashEnv({
      SINK_PORT: '1',
      SINK_TOKEN: 'x',
      SESSION_ID: 's',
      CHANNEL_NAME: 'c',
      BRIDGE_SERVER_NAME: 'n',
      TOOLS_MANIFEST_PATH: '/dev/null',
    }),
    stdin: 'pipe', // kept open — never written/closed
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => proc.kill(), 15000)
  const code = await proc.exited
  clearTimeout(killer)
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
  return { code, out }
}

describe('production entrypoints arm the safety net before early failures', () => {
  test('open/server.ts — an early composer-load failure is logged-then-crashed (finding #1)', () => {
    const home = mkdtempSync(join(tmpdir(), 'f3-os-'))
    try {
      const res = spawnSync('bun', [abs('open/server.ts')], {
        env: crashEnv({ NEUTRON_HOME: join(home, 'h'), NEUTRON_GRAPH_COMPOSER_MODULE: '/nonexistent-xyz.ts' }),
        encoding: 'utf8',
        timeout: 30000,
      })
      expect(res.status).not.toBe(0)
      expect(`${res.stdout}${res.stderr}`).toMatch(STRUCTURED)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('migrations/runner.ts — an unopenable db path is logged-then-crashed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f3-mr-')) // a DIRECTORY is not an openable db file
    try {
      const res = spawnSync('bun', [abs('migrations/runner.ts'), dir], {
        env: crashEnv(),
        encoding: 'utf8',
        timeout: 30000,
      })
      expect(res.status).not.toBe(0)
      expect(`${res.stdout}${res.stderr}`).toMatch(STRUCTURED)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('tools-bridge.ts — installs the net (post-import unhandled failure is caught)', async () => {
    const { code, out } = await importThenInject(abs('runtime/adapters/claude-code/persistent/tools-bridge.ts'))
    expect(code).not.toBe(0)
    expect(out).toMatch(STRUCTURED)
  })

  test('dev-channel.ts — installs the net (post-import unhandled failure is caught)', async () => {
    const { code, out } = await importThenInject(abs('runtime/adapters/claude-code/persistent/dev-channel.ts'))
    expect(code).not.toBe(0)
    expect(out).toMatch(STRUCTURED)
  })

  test('gateway/index.ts installs it in boot(); open/server.ts hoists it before boot', () => {
    // gateway boot() is the composition install; open/server hoists an explicit
    // call BEFORE startOpenServer so it is armed even earlier (boot re-install no-ops).
    expect(readFileSync(abs('gateway/index.ts'), 'utf8')).toContain('installProcessSafetyNet(')
    expect(readFileSync(abs('open/server.ts'), 'utf8')).toContain('installProcessSafetyNet(')
  })
})
