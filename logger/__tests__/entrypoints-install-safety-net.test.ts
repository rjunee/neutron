// F3 (Medium #3 + the static-import boundary) — every PRODUCTION standalone
// entrypoint must arm the process-level rejection/exception safety net so an
// EARLY startup failure is logged-then-crashed (structured `[process] event=…`)
// instead of a bare runtime error. BEHAVIORAL subprocess tests: spawn the real
// entrypoint, trigger a failure, assert (a) nonzero exit + (b) the structured
// log — proving the net is armed BEFORE the failure point.
//
// STANDALONE-ENTRYPOINT INVENTORY (sweep: `import.meta.main`, top-level `await`,
// `bun <script.ts>` spawns) + net coverage:
//   BOOTSTRAP entries (only static import = the logger leaf; arm the net, then
//   DYNAMICALLY import `*-impl.ts` so the impl's WHOLE static graph evaluates
//   after the net is armed):
//     - runtime/.../tools-bridge.ts, dev-channel.ts — spawned MCP processes
//       (static graph pulls the external MCP SDK). [import-inject + shape]
//     - open/diagnostics-cli.ts, landing/boot.ts — clean pure entries (exports
//       are TEST-only). [landing real-entry failure + shape]
//   IN-BODY install (first statement), with a documented, deliberate RESIDUAL
//   (their own static imports of STABLE INTERNAL modules are uncovered; a
//   bootstrap split would repoint live importers / launch wiring):
//     - gateway/index.ts, open/server.ts — dual library+entry primary servers;
//       their failure-prone loads (composer/config) run in the BODY → covered.
//       [bad-composer real-entry]
//     - migrations/runner.ts — dual (gateway boot + stores consume its exports).
//       [bad-db real-entry]
//     - gbrain-doctor.ts — dual (gbrain-memory/index re-exports); self-handling.
//   The bootstrap PATTERN's static-init guarantee (net armed → failing dynamic
//   import → caught) is proven directly by the pattern test below.
//   NOT in-repo: trident launcher (external `claude -p`), Managed launcher
//   (separate repo). Skipped: CI tooling (depcruise-ratchet-compare).
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const abs = (rel: string): string => join(REPO, rel)
const LOGGER = abs('logger/fire-and-forget.ts')
const STRUCTURED = /\[process\] event=(uncaught_exception|unhandled_rejection)/

/** Env with NODE_ENV removed (so the net's crash policy is NOT suppressed). */
function crashEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['NODE_ENV']
  return { ...env, ...extra }
}

/** Spawn an entrypoint with an early failure; return {status, out}. */
function spawnEntry(
  rel: string,
  opts: { env?: Record<string, string>; args?: string[] } = {},
): { status: number | null; out: string } {
  const res = spawnSync('bun', [abs(rel), ...(opts.args ?? [])], {
    env: crashEnv(opts.env),
    encoding: 'utf8',
    timeout: 30000,
  })
  return { status: res.status, out: `${res.stdout}${res.stderr}` }
}

/**
 * Import a top-level-script (bootstrap) entry — arming its net — then inject an
 * unhandled throw. stdin is kept OPEN so the MCP scripts don't graceful-shutdown
 * on EOF first. Proves the entry INSTALLS the net.
 */
async function importThenInject(entryAbs: string): Promise<{ code: number; out: string }> {
  const harness = `await import(${JSON.stringify(entryAbs)}); setTimeout(() => { throw new Error('probe-injected') }, 250)`
  const proc = Bun.spawn(['bun', '-e', harness], {
    env: crashEnv({ SINK_PORT: '1', SINK_TOKEN: 'x', SESSION_ID: 's', CHANNEL_NAME: 'c', BRIDGE_SERVER_NAME: 'n', TOOLS_MANIFEST_PATH: '/dev/null' }),
    stdin: 'pipe',
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
  test('open/server.ts — early composer-load failure is logged-then-crashed (finding #1)', () => {
    const home = mkdtempSync(join(tmpdir(), 'f3-os-'))
    try {
      const { status, out } = spawnEntry('open/server.ts', {
        env: { NEUTRON_HOME: join(home, 'h'), NEUTRON_GRAPH_COMPOSER_MODULE: '/nonexistent-xyz.ts' },
      })
      expect(status).not.toBe(0)
      expect(out).toMatch(STRUCTURED)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('gateway/index.ts — early composer-load failure is logged-then-crashed', () => {
    const home = mkdtempSync(join(tmpdir(), 'f3-gw-'))
    try {
      const { status, out } = spawnEntry('gateway/index.ts', {
        env: { NEUTRON_HOME: join(home, 'h'), NEUTRON_GRAPH_COMPOSER_MODULE: '/nonexistent-xyz.ts' },
      })
      expect(status).not.toBe(0)
      expect(out).toMatch(STRUCTURED)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('migrations/runner.ts — an unopenable db path is logged-then-crashed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f3-mr-')) // a DIRECTORY is not an openable db file
    try {
      const { status, out } = spawnEntry('migrations/runner.ts', { args: [dir] })
      expect(status).not.toBe(0)
      expect(out).toMatch(STRUCTURED)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('landing/boot.ts — an invalid signup port is logged-then-crashed', () => {
    const { status, out } = spawnEntry('landing/boot.ts', { env: { NEUTRON_SIGNUP_PORT: 'notaport' } })
    expect(status).not.toBe(0)
    expect(out).toMatch(STRUCTURED)
  })

  test('tools-bridge.ts (bootstrap) — installs the net (post-import failure is caught)', async () => {
    const { code, out } = await importThenInject(abs('runtime/adapters/claude-code/persistent/tools-bridge.ts'))
    expect(code).not.toBe(0)
    expect(out).toMatch(STRUCTURED)
  })

  test('dev-channel.ts (bootstrap) — installs the net (post-import failure is caught)', async () => {
    const { code, out } = await importThenInject(abs('runtime/adapters/claude-code/persistent/dev-channel.ts'))
    expect(code).not.toBe(0)
    expect(out).toMatch(STRUCTURED)
  })

  // THE static-import boundary: a bootstrap arms the net BEFORE the impl's whole
  // static graph evaluates, so a dependency that fails to RESOLVE during the
  // impl's initialization is caught (structured log), not a bare crash.
  test('bootstrap-indirection covers the impl static-import graph (finding: static init)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f3-boot-'))
    try {
      const bootstrap = join(dir, 'bootstrap.ts')
      // Same shape as tools-bridge.ts / dev-channel.ts: net first, then a
      // DYNAMIC import whose static graph fails to resolve.
      writeFileSync(
        bootstrap,
        `import { installProcessSafetyNet } from ${JSON.stringify(LOGGER)}\n` +
          `installProcessSafetyNet()\n` +
          `await import(${JSON.stringify(join(dir, 'missing-impl.ts'))})\n`,
      )
      const res = spawnSync('bun', [bootstrap], { env: crashEnv(), encoding: 'utf8', timeout: 30000 })
      expect(res.status).not.toBe(0)
      expect(`${res.stdout}${res.stderr}`).toMatch(STRUCTURED)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Self-handling CLIs: prove the net is INSTALLED + does not break a clean run.
  // (They own their error handling → no env-triggerable uncaught path; the net
  // is a backstop, exercised by the shared mechanism + static-init tests above.)
  test('gbrain-doctor.ts + diagnostics-cli.ts install the net and run cleanly under it', () => {
    for (const rel of ['gbrain-memory/gbrain-doctor.ts', 'open/diagnostics-cli.ts']) {
      expect(readFileSync(abs(rel), 'utf8')).toContain('installProcessSafetyNet()')
    }
    // diagnostics-cli is fully synchronous + self-handling → exits 0 cleanly.
    expect(spawnEntry('open/diagnostics-cli.ts').status).toBe(0)
  })

  test('the spawned MCP entries are BOOTSTRAPS (net + dynamic-import, heavy imports moved to *-impl)', () => {
    for (const rel of [
      'runtime/adapters/claude-code/persistent/tools-bridge.ts',
      'runtime/adapters/claude-code/persistent/dev-channel.ts',
    ]) {
      const src = readFileSync(abs(rel), 'utf8')
      expect(src).toContain('installProcessSafetyNet()')
      expect(src).toMatch(/await import\(['"]\.\/[a-z-]+-impl\.ts['"]\)/)
      // heavy external SDK STATIC import must NOT be in the bootstrap (it moved
      // to the impl, so it evaluates AFTER the net is armed). Check import
      // statements only — a doc-comment mention of the package is fine.
      expect(src).not.toMatch(/^\s*import\s.*@modelcontextprotocol/m)
    }
  })

  test('gateway/index.ts + open/server.ts install the net (dual library+entry, documented residual)', () => {
    expect(readFileSync(abs('gateway/index.ts'), 'utf8')).toContain('installProcessSafetyNet(')
    expect(readFileSync(abs('open/server.ts'), 'utf8')).toContain('installProcessSafetyNet(')
  })
})
