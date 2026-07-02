/**
 * `trident/codex-review.sh` — the cross-model review wrapper. Ports Vajra's
 * codex-review.sh into trident. Verified BEHAVIORALLY by spawning the script with
 * a MOCKED `codex` on PATH + a controllable CODEX_HOME, asserting the EXIT CODE
 * mapping the inner-workflow codex reviewer relies on:
 *
 *   0   connected      — codex ran, verdict on stdout
 *   10  not_connected  — no CODEX_HOME / no auth.json (graceful → Claude-only)
 *   11  not_connected  — codex CLI absent
 *   3   deferred       — configured but auth precheck failed (never silent-approve)
 *   5   deferred       — configured + authed but the review call failed
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-review.sh')

interface RunOpts {
  /** Write an auth.json into CODEX_HOME (the "configured" case). */
  authed?: boolean
  /** Don't set CODEX_HOME at all. */
  noCodexHome?: boolean
  /** Put a mock `codex` on PATH whose `login status` exits with this code. */
  codexLoginExit?: number | null
  env?: Record<string, string>
}

function run(opts: RunOpts = {}): { status: number | null; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trident-codex-'))
  const codexHome = join(dir, 'codexhome')
  mkdirSync(codexHome, { recursive: true })
  if (opts.authed === true) writeFileSync(join(codexHome, 'auth.json'), '{"token":"x"}\n')

  // Base PATH excludes any real codex (so codexLoginExit===null → CLI missing).
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  let path = `${bin}${delimiter}/usr/bin${delimiter}/bin`
  if (opts.codexLoginExit !== null && opts.codexLoginExit !== undefined) {
    // Mock codex: `login status` → the given exit; anything else → exit 0.
    const mock = join(bin, 'codex')
    writeFileSync(
      mock,
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${opts.codexLoginExit}; fi\nexit 0\n`,
    )
    chmodSync(mock, 0o755)
  }
  const env: Record<string, string> = {
    PATH: path,
    NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
    ...(opts.env ?? {}),
  }
  if (opts.noCodexHome !== true) env['CODEX_HOME'] = codexHome
  // Run inside a git repo so `git diff` doesn't error — the temp dir is fine (no
  // repo → empty diff, which the script tolerates).
  const res = spawnSync('bash', [SCRIPT, 'main'], { cwd: dir, encoding: 'utf8', env })
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '' }
}

describe('trident/codex-review.sh — exit-code contract', () => {
  test('no CODEX_HOME → exit 10 (not connected, graceful)', () => {
    const { status, stderr } = run({ noCodexHome: true })
    expect(status).toBe(10)
    expect(stderr).toContain('NOT_CONNECTED')
  })

  test('CODEX_HOME set but no auth.json → exit 10 (not connected)', () => {
    const { status, stderr } = run({ authed: false, codexLoginExit: 0 })
    expect(status).toBe(10)
    expect(stderr).toContain('NOT_CONNECTED')
  })

  test('configured but codex CLI absent → exit 11 (not connected)', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: null })
    expect(status).toBe(11)
    expect(stderr).toContain('NOT_CONNECTED')
  })

  test('configured but auth precheck fails → exit 3 (DEFERRED, never silent-approve)', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: 1 })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_REVIEW_AUTH_EXPIRED')
    expect(stderr).toContain('DEFERRED')
  })

  test('configured + authed + review runs → exit 0 (connected), verdict on stdout', () => {
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; echo "looks good"; echo "VERDICT: APPROVE"' },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('VERDICT: APPROVE')
  })

  test('configured + authed but the review CALL fails → exit 5 (DEFERRED)', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; exit 7' },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_REVIEW_CALL_FAILED')
    expect(stderr).toContain('DEFERRED')
  })
})
