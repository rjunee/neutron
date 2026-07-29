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
const SERVICE_SH = join(HERE, '..', '..', 'neutron-service.sh')

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
   * The stub body is irrelevant when `NEUTRON_CLAUDE_SETUP_CMD` replaces the real
   * invocation; only `command -v claude` must succeed. Override `claudeBody` to
   * exercise the REAL `claude setup-token <tty` path (no setup-cmd stub) — e.g.
   * a body that echoes its stdin, to prove the controlling-terminal binding.
   */
  fakeClaude?: boolean
  /** Custom `claude` stub body (default: a no-op `exit 0`). Implies fakeClaude. */
  claudeBody?: string
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
    if (opts.fakeClaude === true || opts.claudeBody !== undefined) {
      const binDir = join(cwd, 'bin')
      mkdirSync(binDir, { recursive: true })
      const stub = join(binDir, 'claude')
      writeFileSync(stub, opts.claudeBody ?? '#!/bin/sh\nexit 0\n')
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

  // ISSUES #318 — Argus minor: a setup-token run that authenticates `claude` to
  // its OWN store but prints no `sk-ant-oat…` token used to hard-stop with a
  // "cancelled sign-in?" message — implying the user failed to auth. But Neutron
  // reads the credential from .env (resolveOpenLlmPool), so it genuinely cannot
  // start a working chat either way — the GATE is correct; only the message was
  // wrong. It must stay gated AND explain honestly that Neutron needs the token.
  test('interactive auth that captures NO token → still gated, but message is honest about why', () => {
    const { vars, stderr } = runAuthSeam(
      {
        NEUTRON_FORCE_INTERACTIVE_AUTH: '1',
        // claude "succeeds" (exit 0) but prints no sk-ant-oat… token to stdout.
        NEUTRON_CLAUDE_SETUP_CMD: 'printf "Login successful.\\n"',
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
      },
      { fakeClaude: true },
    )
    // The gate is the right call — no token in .env means a dead chat.
    expect(vars['CLAUDE_AUTH_PENDING']).toBe('1')
    expect(vars['APP_GATED_ON_AUTH']).toBe('1')
    expect(vars['DO_START']).toBe('0')
    expect(vars['DO_OPEN']).toBe('0')
    // …but the message must be HONEST: no token was captured for Neutron to
    // store, and it reads that token from .env (not "you cancelled sign-in").
    expect(stderr).toContain('no token was captured for Neutron to store')
    expect(stderr).toContain('Neutron reads the subscription token')
    expect(stderr).toContain('ANTHROPIC_API_KEY')
    // It must NOT regress to only blaming a cancelled sign-in.
    expect(stderr).not.toContain('cancelled sign-in')
  })

  // ISSUES #318 — Argus minor: the production `claude setup-token <…tty` binding
  // (the path the headline `curl | sh` install depends on) had no coverage —
  // every prior test routed through the NEUTRON_CLAUDE_SETUP_CMD stub branch. Here
  // we DON'T set that stub, so run_setup_token_capture takes the REAL
  // `claude setup-token <"$NEUTRON_CLAUDE_SETUP_TTY"` branch. The seam only
  // overrides the device path (default /dev/tty) so it's testable without a real
  // controlling terminal; the `<` binding operator under test is the production
  // one. A fake `claude` that echoes its stdin proves the binding actually fed
  // the device to the command — if the redirect were broken, claude's stdin would
  // be the inherited pipe (empty) and no token would be captured.
  test('real `claude setup-token <tty` binding captures the token from the bound device', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neutron-tty-bind-'))
    try {
      const ttyFile = join(cwd, 'fake-tty')
      writeFileSync(ttyFile, 'sk-ant-oat01-FROMTTY\n')
      const { vars, envFile } = runAuthSeam(
        {
          NEUTRON_FORCE_INTERACTIVE_AUTH: '1',
          // NO NEUTRON_CLAUDE_SETUP_CMD → exercises the real `claude setup-token`
          // invocation with the `<tty` redirect; the device is the seam file.
          NEUTRON_CLAUDE_SETUP_TTY: ttyFile,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
          ANTHROPIC_API_KEY: undefined,
        },
        // The fake `claude` echoes whatever stdin it was bound to. With the tty
        // redirect working, that's the token line from ttyFile.
        { claudeBody: '#!/bin/sh\nhead -n 1\n' },
      )
      expect(vars['CLAUDE_AUTH_PENDING']).toBe('0')
      expect(vars['APP_GATED_ON_AUTH']).toBe('0')
      expect(vars['DO_START']).toBe('1')
      // The token the bound device carried was captured + persisted.
      expect(envFile ?? '').toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FROMTTY')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * ISSUES #318 — Argus BLOCKING: the gated-state recovery command must actually
 * start Neutron. The gate SKIPS the service install, so the no-token banner used
 * to advertise bare `neutron start` → `neutron-service.sh do_start` →
 * `launchctl kickstart/bootstrap $PLIST_PATH` (a unit that was never written) →
 * `die "could not start — is it installed?"`. So the primary recovery command
 * died on the exact path this PR fixes.
 *
 * The fix points the banner at `neutron install` (writes the unit AND starts it).
 * This suite proves the behavioral difference with a stateful fake `launchctl`
 * that mirrors real launchd: kickstart/print succeed only once a plist has been
 * bootstrapped, and bootstrap fails on a non-existent plist path (as real
 * launchctl does). The NEUTRON_SERVICE_* seams keep it off the real launchd.
 */
describe('neutron-service.sh — gated recovery command actually starts (ISSUES #318)', () => {
  function runService(
    cmd: string,
    home: string,
    codeDir: string,
    launchctl: string,
  ): { status: number; combined: string } {
    const res = spawnSync('sh', [SERVICE_SH, cmd], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: home,
        NEUTRON_SERVICE_OS: 'darwin',
        NEUTRON_SERVICE_CODE_DIR: codeDir,
        NEUTRON_SERVICE_LAUNCHCTL: launchctl,
        // do_install refuses to write a unit that execs a missing bun; the value
        // is only embedded in the plist (never run here), so any path works.
        BUN_BIN: '/bin/echo',
        NEUTRON_HOME: join(home, 'data'),
      },
    })
    return { status: res.status ?? -1, combined: `${res.stdout ?? ''}\n${res.stderr ?? ''}` }
  }

  test('bare `start` dies before install, then `install` writes the unit and `start` succeeds', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neutron-recovery-'))
    try {
      // Stateful fake launchctl mirroring real launchd: a service can only be
      // kickstarted/printed once its plist has been bootstrapped, and bootstrap
      // fails when the plist path does not exist on disk.
      const launchctl = join(cwd, 'launchctl')
      const stateMarker = join(cwd, 'loaded')
      writeFileSync(
        launchctl,
        [
          '#!/bin/sh',
          `marker='${stateMarker}'`,
          'sub=$1; shift',
          'case "$sub" in',
          // bootstrap <domain> <plist>: load only if the plist file exists.
          '  bootstrap) [ -f "$2" ] && { : > "$marker"; exit 0; } || exit 1 ;;',
          '  bootout)   rm -f "$marker"; exit 0 ;;',
          // kickstart/print/enable succeed only when the service is loaded.
          '  kickstart) shift; [ -f "$marker" ] && exit 0 || exit 1 ;;',
          '  print)     [ -f "$marker" ] && exit 0 || exit 1 ;;',
          '  enable|load) exit 0 ;;',
          '  *) exit 0 ;;',
          'esac',
        ].join('\n'),
      )
      chmodSync(launchctl, 0o755)

      const plist = join(cwd, 'Library', 'LaunchAgents', 'neutron-server.plist')

      // 1. The OLD recovery command on the gated (no-unit) state: DIES.
      const start1 = runService('start', cwd, cwd, launchctl)
      expect(start1.status).not.toBe(0)
      expect(start1.combined).toContain('is it installed')
      expect(existsSync(plist)).toBe(false)

      // 2. The NEW recovery command the banner advertises: writes the unit AND
      //    starts it — exit 0, no die.
      const install = runService('install', cwd, cwd, launchctl)
      expect(install.status).toBe(0)
      expect(existsSync(plist)).toBe(true)

      // 3. With the unit now installed, even bare `start` works — the recovery
      //    actually left Neutron in a startable state.
      const start2 = runService('start', cwd, cwd, launchctl)
      expect(start2.status).toBe(0)
      expect(start2.combined).toContain('started')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  // Lock the banner string itself: the behavioral test above proves `neutron
  // install` recovers, but it cannot reach install.sh's end-of-run banner (that
  // needs a full clone/bun/migrate). Guard that the gated next-step banner leads
  // with the working command and never regresses to bare `neutron start`.
  test('gated banner advertises `neutron install`, not a bare `neutron start`', () => {
    const src = readFileSync(INSTALL_SH, 'utf8')
    // Both the FANCY and plain pending banners must offer `neutron install`.
    const installMentions = src.match(/neutron install/g) ?? []
    expect(installMentions.length).toBeGreaterThanOrEqual(2)
    // The pending banner must not tell the user to run bare `neutron start`
    // (which dies pre-install). `bun run start` / `neutron install` are fine.
    expect(src).not.toMatch(/then[^\n]*neutron start\b/)
  })
})
