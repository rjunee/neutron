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
import { dirname, join } from 'node:path'
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

function runEnvPermsSeam(checkoutDir: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('sh', [INSTALL_SH, '--yes', '--dir', checkoutDir], {
    cwd: checkoutDir,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
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
})
