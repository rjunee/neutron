/**
 * Parity audit gap #1 (P0) — the installer must give a fresh self-host REAL
 * memory.
 *
 * The runtime (`gbrain-memory/`) speaks to GBrain by spawning `gbrain serve`
 * over stdio MCP; when the `gbrain` binary is ABSENT it degrades SILENTLY —
 * entity pages still land on disk, but every knowledge-graph / semantic recall
 * op fails (latched after the first "Executable not found in $PATH: gbrain";
 * see `gbrain-memory/memory-store.ts` `isGbrainBinaryMissingError`). Before this
 * step `install.sh` had ZERO gbrain references, so every fresh install ran
 * without the memory that is core to the Vajra-parity experience.
 *
 * `install.sh` now treats GBrain as a REQUIRED dependency: it installs it by
 * default (`bun install -g github:garrytan/gbrain`), RETRIES transient failures,
 * and if `gbrain` is still not resolvable on PATH it ABORTS the install with an
 * actionable error instead of silently shipping degraded memory. The ONLY way
 * to install without it is the explicit `--no-gbrain` / `NEUTRON_SKIP_GBRAIN`
 * opt-out, which stays graceful.
 *
 * This suite drives the script's `NEUTRON_INSTALL_PRINT_GBRAIN` seam (runs the
 * GBrain install/detect step in isolation, before any bun install / migration)
 * and asserts each branch deterministically. `NEUTRON_GBRAIN_INSTALL_CMD`
 * replaces the real network install with an injected command so the test never
 * hits the network.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = join(HERE, '..', '..', 'install.sh')

interface GbrainSeamResult {
  stdout: string
  stderr: string
  /** stdout + stderr — `info()` writes stdout, `warn()`/spinner write stderr. */
  combined: string
  /** Parsed `KEY=value` lines the seam prints on stdout. */
  vars: Record<string, string>
  /** Process exit status — 0 on success/opt-out, non-zero when `die()` aborts. */
  status: number | null
}

interface RunOpts {
  /** Extra CLI args (e.g. `--no-gbrain`). */
  args?: string[]
  /**
   * Put a stub `gbrain` on PATH BEFORE the seam runs (the idempotent /
   * already-installed case). The install command must then never run.
   */
  preinstalled?: boolean
}

function runGbrainSeam(
  env: Record<string, string | undefined>,
  opts: RunOpts = {},
): GbrainSeamResult {
  const cwd = mkdtempSync(join(tmpdir(), 'neutron-install-gbrain-'))
  // Inherit the real PATH so `ensure_bun` (which runs before the seam) finds the
  // bun this test suite is itself running under, then prepend our own bins.
  let path = process.env['PATH'] ?? '/usr/bin:/bin'
  // BUN_INSTALL controls where ensure_gbrain looks for the global bin dir; point
  // it at the throwaway home so a real ~/.bun/bin never interferes.
  const bunInstall = join(cwd, '.bun')
  const bunBin = join(bunInstall, 'bin')
  mkdirSync(bunBin, { recursive: true })
  if (opts.preinstalled === true) {
    const stub = join(bunBin, 'gbrain')
    writeFileSync(stub, '#!/bin/sh\nexit 0\n')
    chmodSync(stub, 0o755)
    path = `${bunBin}${delimiter}${path}`
  }
  const args = [INSTALL_SH, '--yes', '--dir', join(cwd, 'no-checkout'), ...(opts.args ?? [])]
  const res = spawnSync('sh', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: path,
      HOME: cwd,
      BUN_INSTALL: bunInstall,
      NEUTRON_INSTALL_PRINT_GBRAIN: '1',
      // Keep retry-path tests fast — no real backoff. Callers can override.
      NEUTRON_GBRAIN_RETRY_DELAY: '0',
      ...env,
    },
  })
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  const vars: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m !== null) vars[m[1] as string] = m[2] as string
  }
  return { stdout, stderr, combined: `${stdout}\n${stderr}`, vars, status: res.status }
}

describe('install.sh — GBrain memory self-install (parity gap #1)', () => {
  test('default: install succeeds → real memory enabled', () => {
    // Inject a command that drops a `gbrain` binary into BUN_INSTALL/bin, the
    // same place `bun install -g` would. The seam must then detect it on PATH.
    const { vars, combined } = runGbrainSeam({
      NEUTRON_GBRAIN_INSTALL_CMD:
        'mkdir -p "$BUN_INSTALL/bin" && printf "#!/bin/sh\\nexit 0\\n" > "$BUN_INSTALL/bin/gbrain" && chmod +x "$BUN_INSTALL/bin/gbrain"',
    })
    expect(vars['GBRAIN_INSTALLED']).toBe('1')
    expect(combined).toContain('real KG/semantic memory enabled')
  })

  test('already installed (idempotent) → detected, install command NOT run', () => {
    // A poisoned install command would FAIL if run; since gbrain is already on
    // PATH the seam must short-circuit and never invoke it.
    const { vars, combined } = runGbrainSeam(
      { NEUTRON_GBRAIN_INSTALL_CMD: 'exit 7' },
      { preinstalled: true },
    )
    expect(vars['GBRAIN_INSTALLED']).toBe('1')
    expect(combined).toContain('already installed')
  })

  test('install FAILS after retries → install ABORTS loudly (non-zero), NOT silent-degrade', () => {
    const { vars, stderr, status } = runGbrainSeam({
      NEUTRON_GBRAIN_INSTALL_CMD: 'exit 3',
    })
    // GBrain is REQUIRED: the install must abort, not silently degrade.
    expect(status).not.toBe(0)
    // `die()` exits before the seam prints GBRAIN_INSTALLED=1.
    expect(vars['GBRAIN_INSTALLED']).not.toBe('1')
    expect(stderr).toContain('REQUIRED')
    // And it must hand back the exact manual recovery command + the opt-out.
    expect(stderr).toContain('bun install -g')
    expect(stderr).toContain('--no-gbrain')
  })

  test('retries transient failures, then aborts after exhausting all attempts', () => {
    // A command that fails every time should be retried the full N times — the
    // attempt counter in the warning proves the retry loop actually fired.
    const { stderr, status } = runGbrainSeam({
      NEUTRON_GBRAIN_INSTALL_CMD: 'exit 3',
      NEUTRON_GBRAIN_ATTEMPTS: '3',
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain('attempt 1/3')
    expect(stderr).toContain('attempt 2/3')
    expect(stderr).toContain('failed after 3 attempt')
  })

  test('retry fires on a transient failure, then SUCCEEDS → real memory enabled', () => {
    // Fail the first attempt, then drop a real `gbrain` binary on the second —
    // the seam must recover and confirm gbrain on PATH (no abort).
    const { vars, combined, status } = runGbrainSeam({
      NEUTRON_GBRAIN_ATTEMPTS: '3',
      NEUTRON_GBRAIN_INSTALL_CMD:
        'c="$BUN_INSTALL/attempts"; n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$c"; ' +
        'if [ "$n" -lt 2 ]; then exit 1; fi; ' +
        'mkdir -p "$BUN_INSTALL/bin" && printf "#!/bin/sh\\nexit 0\\n" > "$BUN_INSTALL/bin/gbrain" && chmod +x "$BUN_INSTALL/bin/gbrain"',
    })
    expect(status).toBe(0)
    expect(vars['GBRAIN_INSTALLED']).toBe('1')
    expect(combined).toContain('attempt 1/3') // first try failed → retry warning
    expect(combined).toContain('real KG/semantic memory enabled')
  })

  test('install ran but binary not on PATH → ABORTS with a PATH hint (REQUIRED)', () => {
    // Command "succeeds" but produces no binary — the real-world PATH-gap case.
    // GBrain is REQUIRED, so this aborts rather than shipping degraded memory.
    const { vars, stderr, status } = runGbrainSeam({
      NEUTRON_GBRAIN_INSTALL_CMD: 'true',
    })
    expect(status).not.toBe(0)
    expect(vars['GBRAIN_INSTALLED']).not.toBe('1')
    expect(stderr).toContain('not on PATH')
    expect(stderr).toContain('--no-gbrain')
  })

  test('--no-gbrain opts out → skipped, degradation reported, never installed', () => {
    const { vars, stderr } = runGbrainSeam(
      { NEUTRON_GBRAIN_INSTALL_CMD: 'exit 9' },
      { args: ['--no-gbrain'] },
    )
    expect(vars['GBRAIN_INSTALLED']).toBe('0')
    expect(stderr).toContain('skipping GBrain memory install')
  })

  test('NEUTRON_SKIP_GBRAIN=1 opts out the same way', () => {
    const { vars, stderr } = runGbrainSeam({
      NEUTRON_SKIP_GBRAIN: '1',
      NEUTRON_GBRAIN_INSTALL_CMD: 'exit 9',
    })
    expect(vars['GBRAIN_INSTALLED']).toBe('0')
    expect(stderr).toContain('skipping GBrain memory install')
  })

  test('NEUTRON_GBRAIN_REF overrides the source ref in the abort recovery command', () => {
    const { stderr, status } = runGbrainSeam({
      NEUTRON_GBRAIN_REF: 'github:rjunee/gbrain#pinned',
      NEUTRON_GBRAIN_INSTALL_CMD: 'exit 3',
    })
    expect(status).not.toBe(0)
    expect(stderr).toContain('github:rjunee/gbrain#pinned')
  })
})
