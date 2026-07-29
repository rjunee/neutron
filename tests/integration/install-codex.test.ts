/**
 * Trident cross-model review (Part A) — the installer must give a fresh self-host
 * the Codex CLI so trident's OPTIONAL OpenAI/GPT-5 cross-model review works out of
 * the box.
 *
 * UNLIKE GBrain (which is REQUIRED and aborts the install on failure — see
 * `install-gbrain.test.ts`), the Codex CLI is BEST-EFFORT: `install.sh` installs
 * it by default (`brew install codex`, falling back to `npm install -g
 * @openai/codex`), but ANY failure WARNs and CONTINUES — the trident review
 * degrades gracefully to Claude-only (`trident/codex-review.sh` +
 * `trident/inner-workflow.mjs` treat "codex not connected" as a note, never a
 * merge blocker). The only opt-out is the explicit `--no-codex` /
 * `NEUTRON_SKIP_CODEX`.
 *
 * This suite drives the `NEUTRON_INSTALL_PRINT_CODEX` seam (runs the codex
 * install/detect step in isolation) and asserts each branch. `NEUTRON_CODEX_
 * INSTALL_CMD` replaces the real install so the test never hits the network. To
 * exercise the install branches we must run with a PATH that does NOT already
 * contain a real `codex` (dev machines usually have one) — so we build a SHADOW
 * bin dir holding only a symlink to the test's own `bun` and pin PATH to it.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = join(HERE, '..', '..', 'install.sh')

interface CodexSeamResult {
  stdout: string
  stderr: string
  combined: string
  vars: Record<string, string>
  status: number | null
}

interface RunOpts {
  args?: string[]
  /** Put a stub `codex` on PATH BEFORE the seam runs (the idempotent case). */
  preinstalled?: boolean
}

// Resolve the bun this suite runs under so the shadow PATH still finds it (the
// install script's PATH hygiene needs a working shell, and ensure_bun ran earlier
// in a real install). Falls back to the process execPath dir.
function bunDir(): string {
  const which = spawnSync('command', ['-v', 'bun'], { shell: true, encoding: 'utf8' })
  const p = (which.stdout ?? '').trim()
  return p !== '' ? dirname(p) : dirname(process.execPath)
}

function runCodexSeam(
  env: Record<string, string | undefined>,
  opts: RunOpts = {},
): CodexSeamResult {
  const cwd = mkdtempSync(join(tmpdir(), 'neutron-install-codex-'))
  // SHADOW PATH: a dir with ONLY a `bun` symlink + minimal system dirs, so a real
  // machine-wide `codex` is invisible and the install branches actually run.
  const shadow = join(cwd, 'shadowbin')
  mkdirSync(shadow, { recursive: true })
  try {
    symlinkSync(join(bunDir(), 'bun'), join(shadow, 'bun'))
  } catch {
    // symlink may already exist / be unsupported — best effort.
  }
  let path = `${shadow}${delimiter}/usr/bin${delimiter}/bin`
  const bunInstall = join(cwd, '.bun')
  const bunBin = join(bunInstall, 'bin')
  mkdirSync(bunBin, { recursive: true })
  if (opts.preinstalled === true) {
    const stub = join(bunBin, 'codex')
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
      NEUTRON_INSTALL_PRINT_CODEX: '1',
      NEUTRON_CODEX_RETRY_DELAY: '0',
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

describe('install.sh — Codex CLI self-install (trident cross-model review, best-effort)', () => {
  test('default: install succeeds → cross-model review available', () => {
    const { vars, combined } = runCodexSeam({
      NEUTRON_CODEX_INSTALL_CMD:
        'mkdir -p "$BUN_INSTALL/bin" && printf "#!/bin/sh\\nexit 0\\n" > "$BUN_INSTALL/bin/codex" && chmod +x "$BUN_INSTALL/bin/codex"',
    })
    expect(vars['CODEX_INSTALLED']).toBe('1')
    expect(combined).toContain('Codex CLI installed')
  })

  test('already installed (idempotent) → detected, install command NOT run', () => {
    // A poisoned install command would FAIL if run; codex already on PATH must
    // short-circuit and never invoke it.
    const { vars, combined } = runCodexSeam(
      { NEUTRON_CODEX_INSTALL_CMD: 'exit 7' },
      { preinstalled: true },
    )
    expect(vars['CODEX_INSTALLED']).toBe('1')
    expect(combined).toContain('already installed')
  })

  test('install FAILS after retries → WARN + CONTINUE (exit 0, NOT fatal), CODEX_INSTALLED=0', () => {
    const { vars, stderr, status } = runCodexSeam({
      NEUTRON_CODEX_INSTALL_CMD: 'exit 3',
      NEUTRON_CODEX_ATTEMPTS: '2',
    })
    // Codex is BEST-EFFORT — unlike gbrain, a failure must NOT abort the install.
    expect(status).toBe(0)
    expect(vars['CODEX_INSTALLED']).toBe('0')
    expect(stderr).toContain('degrades to Claude-only')
    // Retry loop actually fired.
    expect(stderr).toContain('attempt 1/2')
    expect(stderr).toContain('failed after 2 attempt')
  })

  test('install ran but binary not on PATH → WARN + CONTINUE (best-effort), CODEX_INSTALLED=0', () => {
    // Command "succeeds" but produces no binary — the PATH-gap case. gbrain aborts
    // here; codex must degrade gracefully.
    const { vars, stderr, status } = runCodexSeam({
      NEUTRON_CODEX_INSTALL_CMD: 'true',
    })
    expect(status).toBe(0)
    expect(vars['CODEX_INSTALLED']).toBe('0')
    expect(stderr).toContain('degrades to Claude-only')
  })

  test('retry fires on a transient failure, then SUCCEEDS → review available', () => {
    const { vars, combined, status } = runCodexSeam({
      NEUTRON_CODEX_ATTEMPTS: '3',
      NEUTRON_CODEX_INSTALL_CMD:
        'c="$BUN_INSTALL/attempts"; n=$(cat "$c" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$c"; ' +
        'if [ "$n" -lt 2 ]; then exit 1; fi; ' +
        'mkdir -p "$BUN_INSTALL/bin" && printf "#!/bin/sh\\nexit 0\\n" > "$BUN_INSTALL/bin/codex" && chmod +x "$BUN_INSTALL/bin/codex"',
    })
    expect(status).toBe(0)
    expect(vars['CODEX_INSTALLED']).toBe('1')
    expect(combined).toContain('attempt 1/3')
    expect(combined).toContain('Codex CLI installed')
  })

  test('--no-codex opts out → skipped, Claude-only degradation reported, never installed', () => {
    const { vars, stderr, status } = runCodexSeam(
      { NEUTRON_CODEX_INSTALL_CMD: 'exit 9' },
      { args: ['--no-codex'] },
    )
    expect(status).toBe(0)
    expect(vars['CODEX_INSTALLED']).toBe('0')
    expect(stderr).toContain('skipping Codex CLI install')
    expect(stderr).toContain('Claude-only')
  })

  test('NEUTRON_SKIP_CODEX=1 opts out the same way', () => {
    const { vars, stderr } = runCodexSeam({
      NEUTRON_SKIP_CODEX: '1',
      NEUTRON_CODEX_INSTALL_CMD: 'exit 9',
    })
    expect(vars['CODEX_INSTALLED']).toBe('0')
    expect(stderr).toContain('skipping Codex CLI install')
  })
})
