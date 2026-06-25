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
 * `install.sh` now installs GBrain by default (`bun install -g
 * github:garrytan/gbrain`) and DETECTS + clearly reports the gap when it can't,
 * without ever aborting the install (the runtime's graceful degradation stays
 * intact). `--no-gbrain` / `NEUTRON_SKIP_GBRAIN` opt out.
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
  return { stdout, stderr, combined: `${stdout}\n${stderr}`, vars }
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

  test('install FAILS → DEGRADED, reported clearly, install NOT aborted', () => {
    const { vars, stderr } = runGbrainSeam({
      NEUTRON_GBRAIN_INSTALL_CMD: 'exit 3',
    })
    // The gap is the whole point: it must NOT silently degrade.
    expect(vars['GBRAIN_INSTALLED']).toBe('0')
    expect(stderr).toContain('DEGRADED')
    // And it must hand back the exact manual recovery command.
    expect(stderr).toContain('bun install -g')
  })

  test('install ran but binary not on PATH → DEGRADED with a PATH hint', () => {
    // Command "succeeds" but produces no binary — the real-world PATH-gap case.
    const { vars, stderr } = runGbrainSeam({
      NEUTRON_GBRAIN_INSTALL_CMD: 'true',
    })
    expect(vars['GBRAIN_INSTALLED']).toBe('0')
    expect(stderr).toContain('not on PATH')
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

  test('NEUTRON_GBRAIN_REF overrides the source ref in the reported command', () => {
    const { stderr } = runGbrainSeam({
      NEUTRON_GBRAIN_REF: 'github:rjunee/gbrain#pinned',
      NEUTRON_GBRAIN_INSTALL_CMD: 'exit 3',
    })
    expect(stderr).toContain('github:rjunee/gbrain#pinned')
  })
})
