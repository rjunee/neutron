/**
 * S3(b) — secrets-at-rest hygiene: `install.sh` writes `.env` (which holds
 * secrets — the onboarding cookie secret, `CLAUDE_CODE_OAUTH_TOKEN`, API
 * keys) but historically never called `chmod` on it, so the file's
 * permissions were whatever the process umask happened to leave behind — on
 * a loose umask (e.g. 022 → 0644), that's group/world-READABLE. The runtime
 * writer (`open/install-token-env.ts:persistOauthTokenToEnv`) already
 * force-0600s its secret file on every write, including on an existing file
 * (`writeFileSync`'s `mode` option only applies on CREATE). This suite
 * asserts `install.sh`'s `ensure_env_file` now matches that idiom.
 *
 * Drives the `NEUTRON_INSTALL_PRINT_ENV_PERMS` seam — runs the `.env`
 * creation/repair step in isolation and exits, without `bun install` /
 * migrations, mirroring the pattern in `install-auth-gate.test.ts` /
 * `install-codex.test.ts`. A synthetic `--dir` checkout (a temp dir carrying
 * a stub `open/server.ts` + `.env.example`) forces LOCAL mode against an
 * isolated dir, so the real repo's `.env` is never touched.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_SH = join(HERE, '..', '..', 'install.sh')

/** Build an isolated fake checkout: `<dir>/open/server.ts` + `<dir>/.env.example`. */
function buildFakeCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neutron-install-envperms-'))
  mkdirSync(join(dir, 'open'), { recursive: true })
  writeFileSync(join(dir, 'open', 'server.ts'), '// stub for resolve_src_dir\n')
  writeFileSync(join(dir, '.env.example'), 'NEUTRON_PORT=7800\n')
  return dir
}

/**
 * Run the seam with an optional PATH-shadowed `chmod` stub so a test can force
 * the fail-closed boundary: `chmodBody` is written as an executable `chmod`
 * earlier on PATH than the real one, letting us simulate (a) a chmod that
 * ERRORS and (b) a chmod that "succeeds" but does not change the mode. Only
 * `chmod` is shadowed — `cp`, `stat`, `grep`, `bun` still resolve to the
 * system binaries.
 */
function runEnvPermsSeam(
  checkoutDir: string,
  opts: { chmodBody?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  let path = process.env['PATH'] ?? '/usr/bin:/bin'
  if (opts.chmodBody !== undefined) {
    const stubDir = join(checkoutDir, 'stubbin')
    mkdirSync(stubDir, { recursive: true })
    const stub = join(stubDir, 'chmod')
    writeFileSync(stub, opts.chmodBody, { mode: 0o755 })
    path = `${stubDir}${delimiter}${path}`
  }
  const res = spawnSync('sh', [INSTALL_SH, '--yes', '--dir', checkoutDir], {
    cwd: checkoutDir,
    encoding: 'utf8',
    env: {
      PATH: path,
      HOME: checkoutDir,
      NEUTRON_INSTALL_PRINT_ENV_PERMS: '1',
    },
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('install.sh — .env is 0600 after write (S3b secrets-at-rest hygiene)', () => {
  test('a fresh .env copied from .env.example ends up 0600', () => {
    const dir = buildFakeCheckout()
    try {
      const { status, stdout } = runEnvPermsSeam(dir)
      expect(status).toBe(0)
      expect(stdout).toContain('env_path=')
      const mode = statSync(join(dir, '.env')).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a pre-existing .env is left untouched in content but tightened to 0600', () => {
    const dir = buildFakeCheckout()
    try {
      const envPath = join(dir, '.env')
      // Simulate an .env written under a loose umask (0644) by a prior install
      // or manual `cp`, holding a real secret value.
      writeFileSync(envPath, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-preexisting\n', { mode: 0o644 })
      expect(statSync(envPath).mode & 0o777).toBe(0o644)

      const { status } = runEnvPermsSeam(dir)
      expect(status).toBe(0)

      const after = statSync(envPath)
      expect(after.mode & 0o777).toBe(0o600)
      // Content is untouched — `ensure_env_file` must never clobber an
      // existing .env, only tighten its permissions.
      expect(readFileSync(envPath, 'utf8')).toBe('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-preexisting\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Fail-CLOSED boundary (Codex blocker): a chmod that CANNOT secure .env must
  // ABORT the install, never be swallowed while secrets are persisted and
  // success is reported. Force it by shadowing `chmod` with a stub that errors.
  test('chmod FAILURE aborts the install (does not report an insecure-.env success)', () => {
    const dir = buildFakeCheckout()
    try {
      const { status, stderr } = runEnvPermsSeam(dir, { chmodBody: '#!/bin/sh\nexit 1\n' })
      expect(status).toBe(1)
      expect(stderr).toContain('refusing to continue')
      expect(stderr).toContain('could not secure')
      // The seam's success line (`env_path=`) prints on stdout only when it
      // runs to completion — the abort must happen before it.
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Belt-and-suspenders (Codex blocker): a chmod that "succeeds" (exit 0) but
  // does NOT change the mode — e.g. an exotic FS/mount — must still be caught
  // by the stat-verify and abort. Stub `chmod` as a no-op; a pre-existing 0644
  // .env then stays 0644 despite the exit-0 chmod.
  test('chmod that silently does not stick is caught by stat-verify and aborts', () => {
    const dir = buildFakeCheckout()
    try {
      const envPath = join(dir, '.env')
      writeFileSync(envPath, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-preexisting\n', { mode: 0o644 })
      expect(statSync(envPath).mode & 0o777).toBe(0o644)

      const { status, stderr } = runEnvPermsSeam(dir, { chmodBody: '#!/bin/sh\nexit 0\n' })
      expect(status).toBe(1)
      expect(stderr).toContain('permissions did not stick')
      // The file really did stay insecure — proving the verify caught a real hole.
      expect(statSync(envPath).mode & 0o777).toBe(0o644)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
