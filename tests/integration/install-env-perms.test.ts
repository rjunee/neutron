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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Single-quote a string for safe embedding in a `sh -c` command. */
function quoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Run the seam with optional PATH-shadowed `chmod` / `stat` stubs so a test can
 * force the fail-closed boundaries: each `*Body` is written as an executable
 * earlier on PATH than the real one, letting us simulate a chmod that ERRORS, a
 * chmod that "succeeds" but does not change the mode, and a `stat` that
 * fails/lies (so the mandatory verify readback cannot confirm 0600). Only the
 * shadowed commands are replaced — `cp`, `grep`, `bun`, and any un-stubbed tool
 * still resolve to the system binaries.
 */
function runEnvPermsSeam(
  checkoutDir: string,
  opts: { chmodBody?: string; statBody?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  let path = process.env['PATH'] ?? '/usr/bin:/bin'
  if (opts.chmodBody !== undefined || opts.statBody !== undefined) {
    const stubDir = join(checkoutDir, 'stubbin')
    mkdirSync(stubDir, { recursive: true })
    if (opts.chmodBody !== undefined) {
      writeFileSync(join(stubDir, 'chmod'), opts.chmodBody, { mode: 0o755 })
    }
    if (opts.statBody !== undefined) {
      writeFileSync(join(stubDir, 'stat'), opts.statBody, { mode: 0o755 })
    }
    path = `${stubDir}${delimiter}${path}`
  }
  // Force a LOOSE umask (022) in the spawned shell so that if install.sh did
  // NOT birth `.env` at 0600, the file would land 0644 (world/group-readable).
  // This makes the birth-secure (`umask 077`) behavior meaningfully testable:
  // under the fix, .env is 0600 from creation even when the ambient umask is
  // loose and even when a later chmod fails.
  const inner = `umask 022; exec sh ${quoteSh(INSTALL_SH)} --yes --dir ${quoteSh(checkoutDir)}`
  const res = spawnSync('sh', ['-c', inner], {
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
  test('chmod FAILURE aborts the install AND leaves no exposed secret on disk', () => {
    const dir = buildFakeCheckout()
    try {
      const { status, stdout, stderr } = runEnvPermsSeam(dir, { chmodBody: '#!/bin/sh\nexit 1\n' })
      expect(status).toBe(1)
      expect(stderr).toContain('refusing to continue')
      expect(stderr).toContain('could not secure')
      // The seam's success line (`env_path=`) only prints on full completion —
      // the abort must happen before it.
      expect(stdout).not.toContain('env_path=')

      // POST-FAILURE FILESYSTEM STATE (Codex blocker #1): even though chmod
      // failed, the abort must NOT leave a world/group-readable secret sitting
      // on disk. `.env` is born 0600 via `umask 077` (the seam runs under a
      // loose umask 022), so the post-abort state is either absent OR 0600 —
      // never a 0644 file containing secrets.
      const envPath = join(dir, '.env')
      if (existsSync(envPath)) {
        expect(statSync(envPath).mode & 0o777).toBe(0o600)
      }
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

  // Mandatory-verify boundary (Codex blocker): chmod's exit code alone is
  // untrustworthy (a no-op / shimmed chmod exits 0), so the perms guarantee
  // MUST come from a positive `stat` readback. If chmod lies AND stat cannot
  // confirm the mode, the installer must FAIL CLOSED — never trust the lying
  // chmod. A no-op chmod + a FAILING stat on a pre-existing 0644 .env: the
  // install must abort and the secret must stay proven-insecure (not silently
  // accepted as "secured").
  test('no-op chmod + FAILING stat aborts (cannot verify → refuse, secret stays insecure)', () => {
    const dir = buildFakeCheckout()
    try {
      const envPath = join(dir, '.env')
      writeFileSync(envPath, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-preexisting\n', { mode: 0o644 })
      expect(statSync(envPath).mode & 0o777).toBe(0o644)

      const { status, stdout, stderr } = runEnvPermsSeam(dir, {
        chmodBody: '#!/bin/sh\nexit 0\n', // "succeeds" but changes nothing
        statBody: '#!/bin/sh\nexit 1\n', // both stat forms fail → mode unverifiable
      })
      expect(status).toBe(1)
      expect(stderr).toContain('cannot verify')
      expect(stdout).not.toContain('env_path=')
      // The install did NOT silently trust the lying chmod: the file is still 0644.
      expect(statSync(envPath).mode & 0o777).toBe(0o644)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Symlink-safety boundary (Codex blocker): the secret REPLACE path writes to
  // a temp file next to `.env` before an atomic rename. That temp MUST be
  // created securely (mktemp = exclusive O_EXCL create of a RANDOM name, which
  // never follows or overwrites a pre-existing path). If mktemp is unavailable
  // the installer must FAIL CLOSED — the old predictable-name fallback
  // (`.neutron-env.tmp.$$` truncated with `:>`) would FOLLOW an attacker's
  // pre-planted symlink and write the .env secret to an attacker-chosen target.
  // Force it: shadow `mktemp` to fail, drive the replace path (pre-seed the key
  // so persist_env_var takes the temp-file branch) → the install ABORTS, writes
  // NO secret, creates no predictable temp file, and leaves any attacker target
  // byte-for-byte untouched.
  test('mktemp FAILURE on the secret replace path fails closed (no secret written, no symlink followed)', () => {
    const dir = buildFakeCheckout()
    try {
      const envPath = join(dir, '.env')
      // Pre-seed the key so persist_env_var takes the REPLACE branch (the one
      // that uses a temp file), holding a real prior secret value.
      writeFileSync(envPath, 'NEUTRON_TEST_SECRET=prior-secret-value\n', { mode: 0o600 })
      // An attacker's target the old predictable-name symlink would have pointed
      // at — must remain byte-for-byte unchanged.
      const attackerTarget = join(dir, 'attacker-target')
      writeFileSync(attackerTarget, 'ORIGINAL-ATTACKER-CONTENT\n')

      const stubDir = join(dir, 'stubbin')
      mkdirSync(stubDir, { recursive: true })
      writeFileSync(join(stubDir, 'mktemp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const path = `${stubDir}${delimiter}${process.env['PATH'] ?? '/usr/bin:/bin'}`
      const inner = `umask 022; exec sh ${quoteSh(INSTALL_SH)} --yes --dir ${quoteSh(dir)}`
      const res = spawnSync('sh', ['-c', inner], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: path,
          HOME: dir,
          NEUTRON_INSTALL_PERSIST_ENV_VAR: '1',
          NEUTRON_TEST_PERSIST_KEY: 'NEUTRON_TEST_SECRET',
        },
      })

      // (a) FAILS CLOSED with a clear, secret-refusing error.
      expect(res.status).toBe(1)
      expect(res.stderr).toContain('refusing to write secrets')
      // (b) No success line — the abort happened before the persist completed.
      expect(res.stdout ?? '').not.toContain('persisted=')
      // (c) The secret was NOT written/replaced — .env is byte-for-byte the prior value.
      expect(readFileSync(envPath, 'utf8')).toBe('NEUTRON_TEST_SECRET=prior-secret-value\n')
      // (d) No predictable temp file was created (the old fallback name was
      // `.neutron-env.tmp.<pid>`), and the attacker's target is untouched.
      const strays = readdirSync(dir).filter((n) => n.startsWith('.neutron-env.tmp.'))
      expect(strays).toEqual([])
      expect(readFileSync(attackerTarget, 'utf8')).toBe('ORIGINAL-ATTACKER-CONTENT\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Same fail-closed rule for a stat that "succeeds" (exit 0) but returns
  // MALFORMED / non-octal output — an unrecognized mode cannot confirm 0600, so
  // the install must refuse rather than accept it.
  test('no-op chmod + MALFORMED stat output aborts (unrecognized mode → refuse)', () => {
    const dir = buildFakeCheckout()
    try {
      const envPath = join(dir, '.env')
      writeFileSync(envPath, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-preexisting\n', { mode: 0o644 })
      expect(statSync(envPath).mode & 0o777).toBe(0o644)

      const { status, stdout, stderr } = runEnvPermsSeam(dir, {
        chmodBody: '#!/bin/sh\nexit 0\n',
        statBody: '#!/bin/sh\necho not-an-octal-mode\nexit 0\n', // lies with junk output
      })
      expect(status).toBe(1)
      expect(stderr).toContain('cannot verify')
      expect(stdout).not.toContain('env_path=')
      expect(statSync(envPath).mode & 0o777).toBe(0o644)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
