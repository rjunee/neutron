/**
 * ISSUES #318 — the installer must NOT land in a dead chat.
 *
 * Owner repro: `curl …/install.sh | sh -s -- --yes` SKIPPED the Claude-auth
 * step (printed a "not authenticated" warning) and then PROCEEDED to start the
 * server + open the chat window — which is unusable with no
 * `CLAUDE_CODE_OAUTH_TOKEN`. Owner: "it shouldnt just proceed and open chat
 * window. its unusable without claude."
 *
 * The fix makes Claude auth a HARD GATE (`install.sh:apply_auth_gate`): when the
 * auth step did not complete, the install must NOT start the service, start the
 * server, or open the browser. It either runs auth (interactive / `/dev/tty`
 * behind a pipe) or hard-stops with the `claude setup-token` instructions.
 *
 * This suite drives the script's `NEUTRON_INSTALL_PRINT_AUTH` seam (runs the
 * auth detection + gate decision in isolation, before any bun install /
 * migration) and asserts the gate decision deterministically. The
 * `NEUTRON_ASSUME_NO_TTY` seam forces the "truly no terminal" branch regardless
 * of the test runner's `/dev/tty`, so a `--yes` install with no token can never
 * reach a started-app/open-chat state.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = join(HERE, '..', '..', 'install.sh')

interface AuthSeamResult {
  stdout: string
  stderr: string
  /** stdout + stderr — `info()` writes stdout, `warn()` writes stderr. */
  combined: string
  /** Parsed `KEY=value` lines the seam prints on stdout. */
  vars: Record<string, string>
  /** Contents of the `.env` the auth-capture path may have written, or null. */
  envFile: string | null
}

interface RunOpts {
  /**
   * Put a stub `claude` on PATH. `ensure_claude_auth` checks `command -v claude`
   * before it reaches the setup-token capture seam, so the capture-path test
   * must not depend on a real Claude CLI being installed (it isn't, in CI).
   * The stub body is irrelevant — `NEUTRON_CLAUDE_SETUP_CMD` replaces the real
   * invocation; only `command -v claude` must succeed.
   */
  fakeClaude?: boolean
}

function runAuthSeam(
  env: Record<string, string | undefined>,
  opts: RunOpts = {},
): AuthSeamResult {
  // Run in a throwaway cwd and point --dir at a NON-checkout path so the seam's
  // SRC_DIR resolves empty and the env file falls back to cwd — keeping any
  // `.env` the capture path writes out of the repo / install.sh's own dir.
  const cwd = mkdtempSync(join(tmpdir(), 'neutron-install-gate-'))
  try {
    let path = process.env['PATH'] ?? '/usr/bin:/bin'
    if (opts.fakeClaude === true) {
      const binDir = join(cwd, 'bin')
      mkdirSync(binDir, { recursive: true })
      const stub = join(binDir, 'claude')
      writeFileSync(stub, '#!/bin/sh\nexit 0\n')
      chmodSync(stub, 0o755)
      path = `${binDir}${delimiter}${path}`
    }
    const res = spawnSync('sh', [INSTALL_SH, '--yes', '--dir', join(cwd, 'no-checkout')], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: path,
        HOME: cwd,
        NEUTRON_INSTALL_PRINT_AUTH: '1',
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
    const envPath = join(cwd, '.env')
    const envFile = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null
    return { stdout, stderr, combined: `${stdout}\n${stderr}`, vars, envFile }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('install.sh — Claude auth is a hard gate (ISSUES #318)', () => {
  test('--yes, no token, no terminal → HARD-STOP: gated, start/open forced OFF', () => {
    const { vars, stderr } = runAuthSeam(
      {
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        NEUTRON_ASSUME_NO_TTY: '1',
      },
      // claude IS installed (the owner's case) — force the no-terminal hard-stop
      // branch, not the claude-absent branch, so the gate is what's under test.
      { fakeClaude: true },
    )
    // Auth never completed → pending → gate engaged.
    expect(vars['CLAUDE_AUTH_PENDING']).toBe('1')
    expect(vars['APP_GATED_ON_AUTH']).toBe('1')
    // The whole point: the box must NOT start the server or open the browser.
    expect(vars['DO_START']).toBe('0')
    expect(vars['DO_OPEN']).toBe('0')
    // And it must say so clearly (the setup-token instructions, not a silent skip).
    expect(stderr).toContain('claude setup-token')
  })

  test('a present CLAUDE_CODE_OAUTH_TOKEN → NOT gated, start/open stay enabled', () => {
    const { vars, combined } = runAuthSeam({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-present',
      ANTHROPIC_API_KEY: undefined,
      NEUTRON_ASSUME_NO_TTY: '1',
    })
    expect(vars['CLAUDE_AUTH_PENDING']).toBe('0')
    expect(vars['APP_GATED_ON_AUTH']).toBe('0')
    expect(vars['DO_START']).toBe('1')
    expect(vars['DO_OPEN']).toBe('1')
    expect(combined).toContain('Claude auth detected')
  })

  test('a present ANTHROPIC_API_KEY → NOT gated', () => {
    const { vars } = runAuthSeam({
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: 'sk-ant-api03-present',
      NEUTRON_ASSUME_NO_TTY: '1',
    })
    expect(vars['CLAUDE_AUTH_PENDING']).toBe('0')
    expect(vars['APP_GATED_ON_AUTH']).toBe('0')
    expect(vars['DO_START']).toBe('1')
  })

  test('--yes with a reachable terminal RUNS the auth step (captures token) → NOT gated', () => {
    // The owner case: `curl | sh -s -- --yes` is non-interactive on stdin but a
    // real terminal is reachable. We force-interactive (the test seam for "a
    // terminal is available") and stub `claude setup-token` to print a token.
    // The installer must CAPTURE + persist it and complete auth — never gate.
    const { vars, envFile } = runAuthSeam(
      {
        NEUTRON_FORCE_INTERACTIVE_AUTH: '1',
        NEUTRON_CLAUDE_SETUP_CMD: 'printf "sk-ant-oat01-CAPTURED\\n"',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      // The capture path runs only when `command -v claude` succeeds — stub it
      // so this test passes whether or not a real Claude CLI is installed.
      { fakeClaude: true },
    )
    expect(vars['CLAUDE_AUTH_PENDING']).toBe('0')
    expect(vars['APP_GATED_ON_AUTH']).toBe('0')
    expect(vars['DO_START']).toBe('1')
    // The captured token was persisted so the next server start actually has it.
    expect(envFile).not.toBeNull()
    expect(envFile ?? '').toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-CAPTURED')
  })
})
